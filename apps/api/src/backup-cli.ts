import { createBackup, restoreBackup, validateBackup } from './services/backup.js';

const [command, dataDir, backupDir, confirmation] = process.argv.slice(2);

try {
  if (command === 'validate' && dataDir) {
    const manifest = await validateBackup(dataDir);
    console.log(`Backup is valid: ${manifest.files.length} files, created ${manifest.createdAt}.`);
  } else if (command === 'create' && dataDir && backupDir) {
    console.log(`Backup created at ${await createBackup(dataDir, backupDir)}.`);
  } else if (command === 'restore' && dataDir && backupDir && confirmation === 'RESTORE_VALIDATED_BACKUP') {
    const result = await restoreBackup(dataDir, backupDir);
    console.log(`Restore completed. Previous live data preserved at ${result.previousDataDirectory}. Shopify reconciliation is required before mutation.`);
  } else {
    throw new Error('Usage: backup-cli validate <backup-dir> | create <data-dir> <backup-dir> | restore <data-dir> <backup-dir> RESTORE_VALIDATED_BACKUP');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed.');
  process.exitCode = 1;
}
