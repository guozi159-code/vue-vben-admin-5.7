const remoteName = process.argv[2] ?? '';

if (remoteName !== 'origin') {
  console.error('Push blocked: only the origin remote is allowed.');
  console.error(`Current remote: ${remoteName || '(empty)'}`);
  process.exit(1);
}
