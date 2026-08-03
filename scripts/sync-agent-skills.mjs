import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = join(projectRoot, '.agents');
const skillsDir = join(agentsDir, 'skills');
const manifestPath = join(agentsDir, 'external-skills.json');
const lockPath = join(agentsDir, 'external-skills.lock.json');

async function pathExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback) {
  if (!(await pathExists(path))) {
    return fallback;
  }

  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function validateManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.imports)) {
    throw new Error(
      'external-skills.json 必须包含 version: 1 和 imports 数组。',
    );
  }

  const names = new Set();
  const targets = new Set();

  for (const item of manifest.imports) {
    if (!item?.name || !item?.target || !item?.source) {
      throw new Error('每个外部 Skill 都必须包含 name、target 和 source。');
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.target)) {
      throw new Error(
        `Skill ${item.name} 的 target 只能使用小写字母、数字和连字符。`,
      );
    }
    if (names.has(item.name) || targets.has(item.target)) {
      throw new Error(`Skill ${item.name} 的 name 或 target 重复。`);
    }
    if (
      item.source.type !== 'git' ||
      !item.source.url ||
      !item.source.ref ||
      !item.source.path
    ) {
      throw new Error(`Skill ${item.name} 目前只支持完整的 git 来源配置。`);
    }
    if (
      isAbsolute(item.source.path) ||
      item.source.path.split(/[\\/]/).includes('..')
    ) {
      throw new Error(
        `Skill ${item.name} 的 source.path 必须是仓库内相对路径。`,
      );
    }

    names.add(item.name);
    targets.add(item.target);
  }
}

function selectImports(imports, requestedNames) {
  if (requestedNames.length === 0) {
    return imports;
  }

  const requested = new Set(requestedNames);
  const selected = imports.filter((item) => requested.delete(item.name));

  if (requested.size > 0) {
    throw new Error(`未找到外部 Skill：${[...requested].join(', ')}`);
  }

  return selected;
}

async function hashDirectory(root) {
  const hash = createHash('sha256');

  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');

      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await visit(absolutePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${await fs.readlink(absolutePath)}\0`,
        );
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(await fs.readFile(absolutePath));
        hash.update('\0');
      }
    }
  }

  await visit(root);
  return `sha256:${hash.digest('hex')}`;
}

function sameSource(left, right) {
  return (
    left?.type === right.type &&
    left?.url === right.url &&
    left?.ref === right.ref &&
    left?.path === right.path
  );
}

async function validateSkillDirectory(skillName, sourceDir) {
  const skillPath = join(sourceDir, 'SKILL.md');
  if (!(await pathExists(skillPath))) {
    throw new Error(`Skill ${skillName} 的来源目录缺少 SKILL.md。`);
  }

  const contents = await fs.readFile(skillPath, 'utf8');
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (
    !frontmatter ||
    !/^name:\s*\S+/m.test(frontmatter[1]) ||
    !/^description:\s*\S+/m.test(frontmatter[1])
  ) {
    throw new Error(
      `Skill ${skillName} 的 SKILL.md 缺少有效的 name 或 description。`,
    );
  }
}

async function cloneSources(imports, temporaryRoot) {
  const groups = new Map();

  for (const item of imports) {
    const key = JSON.stringify([item.source.url, item.source.ref]);
    const group = groups.get(key) ?? { items: [], source: item.source };
    group.items.push(item);
    groups.set(key, group);
  }

  const prepared = new Map();
  let groupIndex = 0;

  for (const group of groups.values()) {
    const repositoryDir = join(temporaryRoot, `repository-${groupIndex++}`);
    console.log(`正在获取 ${group.source.url}#${group.source.ref}`);
    await execFileAsync(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        group.source.ref,
        group.source.url,
        repositoryDir,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const { stdout } = await execFileAsync('git', [
      '-C',
      repositoryDir,
      'rev-parse',
      'HEAD',
    ]);
    const resolvedCommit = stdout.trim();

    for (const item of group.items) {
      const sourceDir = resolve(repositoryDir, item.source.path);
      if (!sourceDir.startsWith(`${repositoryDir}${sep}`)) {
        throw new Error(`Skill ${item.name} 的来源路径越界。`);
      }
      await validateSkillDirectory(item.name, sourceDir);

      prepared.set(item.name, {
        contentHash: await hashDirectory(sourceDir),
        item,
        resolvedCommit,
        sourceDir,
      });
    }
  }

  return prepared;
}

async function checkSkills(manifest, lock, selected) {
  let hasError = false;

  for (const item of selected) {
    const locked = lock?.skills?.[item.name];
    const targetDir = join(skillsDir, item.target);

    if (!locked) {
      console.error(`✗ ${item.name} 尚未写入锁文件`);
      hasError = true;
      continue;
    }
    if (
      locked.target !== item.target ||
      !sameSource(locked.source, item.source)
    ) {
      console.error(`✗ ${item.name} 的声明与锁文件不一致`);
      hasError = true;
      continue;
    }
    if (!(await pathExists(join(targetDir, 'SKILL.md')))) {
      console.error(`✗ ${item.name} 的目标目录缺少 SKILL.md`);
      hasError = true;
      continue;
    }

    const contentHash = await hashDirectory(targetDir);
    if (contentHash !== locked.contentHash) {
      console.error(`✗ ${item.name} 存在未同步的本地修改`);
      hasError = true;
      continue;
    }

    console.log(`✓ ${item.name} @ ${locked.resolvedCommit.slice(0, 12)}`);
  }

  if (selected.length === manifest.imports.length) {
    const declaredNames = new Set(manifest.imports.map((item) => item.name));
    for (const lockedName of Object.keys(lock?.skills ?? {})) {
      if (!declaredNames.has(lockedName)) {
        console.error(`✗ 锁文件包含已移除的 Skill：${lockedName}`);
        hasError = true;
      }
    }
  }

  if (hasError) {
    process.exitCode = 1;
  }
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.tmp`,
  );
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporaryPath, path);
}

async function syncSkills(manifest, existingLock, selected, isFullSync) {
  const temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'agent-skills-sync-'));
  let replacementRoot;

  try {
    const prepared = await cloneSources(selected, temporaryRoot);

    for (const item of selected) {
      const targetDir = join(skillsDir, item.target);
      if (!(await pathExists(targetDir))) {
        continue;
      }

      const currentHash = await hashDirectory(targetDir);
      const locked = existingLock?.skills?.[item.name];
      if (locked) {
        if (currentHash !== locked.contentHash) {
          throw new Error(
            `Skill ${item.name} 存在本地修改，请先处理差异再同步。`,
          );
        }
      } else if (currentHash !== prepared.get(item.name).contentHash) {
        throw new Error(
          `目录 ${item.target} 尚未受同步器管理，且内容与上游不同，已停止覆盖。`,
        );
      }
    }

    await fs.mkdir(skillsDir, { recursive: true });
    replacementRoot = await fs.mkdtemp(join(agentsDir, '.skills-sync-'));
    const stagedDir = join(replacementRoot, 'staged');
    const backupDir = join(replacementRoot, 'backup');
    await fs.mkdir(stagedDir, { recursive: true });
    await fs.mkdir(backupDir, { recursive: true });

    for (const item of selected) {
      await fs.cp(
        prepared.get(item.name).sourceDir,
        join(stagedDir, item.target),
        {
          recursive: true,
        },
      );
    }

    const replaced = [];
    try {
      for (const item of selected) {
        const targetDir = join(skillsDir, item.target);
        const backupTarget = join(backupDir, item.target);
        const hadTarget = await pathExists(targetDir);
        if (hadTarget) {
          await fs.rename(targetDir, backupTarget);
        }
        await fs.rename(join(stagedDir, item.target), targetDir);
        replaced.push({ backupTarget, hadTarget, targetDir });
      }

      const nextSkills = isFullSync ? {} : { ...existingLock?.skills };
      for (const item of selected) {
        const current = prepared.get(item.name);
        nextSkills[item.name] = {
          target: item.target,
          source: item.source,
          resolvedCommit: current.resolvedCommit,
          contentHash: current.contentHash,
        };
      }
      await writeJsonAtomic(lockPath, { version: 1, skills: nextSkills });
    } catch (error) {
      for (const replacement of replaced.toReversed()) {
        await fs.rm(replacement.targetDir, { force: true, recursive: true });
        if (replacement.hadTarget) {
          await fs.rename(replacement.backupTarget, replacement.targetDir);
        }
      }
      throw error;
    }

    for (const item of selected) {
      const current = prepared.get(item.name);
      console.log(
        `✓ 已同步 ${item.name} @ ${current.resolvedCommit.slice(0, 12)}`,
      );
    }
  } finally {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
    if (replacementRoot) {
      await fs.rm(replacementRoot, { force: true, recursive: true });
    }
  }
}

async function main() {
  const command = process.argv[2];
  const requestedNames = process.argv.slice(3);
  if (!['check', 'sync'].includes(command)) {
    throw new Error(
      '用法：node scripts/sync-agent-skills.mjs <sync|check> [skill-name...]',
    );
  }

  const manifest = await readJson(manifestPath);
  validateManifest(manifest);
  const selected = selectImports(manifest.imports, requestedNames);
  const lock = await readJson(lockPath, { version: 1, skills: {} });

  if (command === 'check') {
    await checkSkills(manifest, lock, selected);
    return;
  }

  await syncSkills(manifest, lock, selected, requestedNames.length === 0);
}

main().catch((error) => {
  console.error(`外部 Skill 操作失败：${error.message}`);
  process.exitCode = 1;
});
