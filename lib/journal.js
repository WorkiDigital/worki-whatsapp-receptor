import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync, mkdirSync, fstatSync, readSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Diário append-only (JSONL) com fsync antes de retornar. Cauda truncada por queda é ignorada na leitura.
// Contém dados privados (números, pedidos): fica em DATA_DIR (volume), fora do Git, modo 0600.
export class Journal {
  constructor(path) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.corruptLines = 0;
  }

  // Lê todos os registros válidos, em ordem, e abre o arquivo para anexar.
  open(onRecord) {
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line) continue;
        let r;
        try { r = JSON.parse(line); } catch { this.corruptLines++; continue; }
        onRecord(r);
      }
    }
    this.fd = openSync(this.path, 'a', 0o600);
    const size = fstatSync(this.fd).size;
    if (size) {
      const b = Buffer.alloc(1);
      const rfd = openSync(this.path, 'r');
      try { readSync(rfd, b, 0, 1, size - 1); } finally { closeSync(rfd); }
      if (b[0] !== 0x0a) { writeSync(this.fd, '\n'); fsyncSync(this.fd); }
    }
  }

  append(rec) {
    writeSync(this.fd, `${JSON.stringify(rec)}\n`);
    fsyncSync(this.fd);
  }

  close() { try { closeSync(this.fd); } catch { /* já fechado */ } }

  // Substituição atômica: sincronizar temporário, renomear e sincronizar diretório.
  compact(records) {
    const tmp = `${this.path}.compact`;
    const fd = openSync(tmp, 'w', 0o600);
    try { for (const r of records) writeSync(fd, `${JSON.stringify(r)}\n`); fsyncSync(fd); }
    catch (e) { closeSync(fd); try { unlinkSync(tmp); } catch {} throw e; }
    closeSync(fd);
    renameSync(tmp, this.path);
    this.close();
    this.fd = openSync(this.path, 'a', 0o600);
    const d = openSync(dirname(this.path), 'r');
    try { fsyncSync(d); } finally { closeSync(d); }
  }
}
