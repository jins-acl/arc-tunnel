const nodeFs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function publishDashboard(options = {}) {
  const operations = options.fs || nodeFs;
  const source = options.source || 'src/dashboard';
  const destination = options.destination || 'dist/dashboard';
  const uniqueId = options.uniqueId || randomUUID();
  const parent = path.dirname(destination);
  const name = path.basename(destination);
  const temporary = path.join(parent, `.${name}.tmp-${uniqueId}`);
  const backup = path.join(parent, `.${name}.backup-${uniqueId}`);
  let previousMoved = false;
  let replacementPublished = false;

  operations.rmSync(temporary, { recursive: true, force: true });
  operations.rmSync(backup, { recursive: true, force: true });
  try {
    operations.cpSync(source, temporary, { recursive: true });
    if (operations.existsSync(destination)) {
      operations.renameSync(destination, backup);
      previousMoved = true;
    }
    try {
      operations.renameSync(temporary, destination);
      replacementPublished = true;
    } catch (error) {
      if (previousMoved) {
        operations.rmSync(destination, { recursive: true, force: true });
        operations.renameSync(backup, destination);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) {
      operations.rmSync(backup, { recursive: true, force: true });
      previousMoved = false;
    }
  } finally {
    operations.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && !replacementPublished) {
      operations.rmSync(destination, { recursive: true, force: true });
      operations.renameSync(backup, destination);
      previousMoved = false;
    }
    operations.rmSync(backup, { recursive: true, force: true });
  }
}

module.exports = { publishDashboard };
