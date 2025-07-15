import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_FILE = path.join(__dirname, '../.checkpoint.json');

export async function loadCheckpoint() {
  try {
    const data = await fs.readFile(CHECKPOINT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist, return default checkpoint
    return {
      lastProcessedDate: null,
      totalProcessed: 0,
      lastRun: null
    };
  }
}

export async function saveCheckpoint(checkpoint) {
  await fs.writeFile(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

export async function updateCheckpoint(newData) {
  const current = await loadCheckpoint();
  const updated = {
    ...current,
    ...newData,
    lastRun: new Date().toISOString()
  };
  await saveCheckpoint(updated);
  return updated;
}