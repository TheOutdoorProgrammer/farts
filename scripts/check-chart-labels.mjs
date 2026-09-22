import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'farts-chart-labels-'));
const versions = [
  '0.1.0',
  '0.1.0+2658faafbd07',
  `0.1.0+${'a'.repeat(80)}`,
  `0.1.0+${'a'.repeat(50)}.x`,
  `0.1.0-${'a'.repeat(49)}-.x`,
];

try {
  for (const version of versions) {
    execFileSync('helm', [
      'package',
      'charts/farts',
      '--version',
      version,
      '--destination',
      directory,
    ]);
    const rendered = execFileSync(
      'helm',
      [
        'template',
        'farts',
        join(directory, `farts-${version}.tgz`),
        '--set',
        'station.id=30605',
        '--set',
        'ingress.enabled=true',
        '--set',
        'ingress.host=recordings.example.com',
      ],
      { encoding: 'utf8' },
    );
    const labels = [...rendered.matchAll(/^\s*helm\.sh\/chart:\s*(.+)$/gm)];
    assert(labels.length > 0, `No chart labels rendered for ${version}`);
    for (const [, encoded] of labels) {
      const label = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
      assert(label.length <= 63, `Chart label exceeds 63 characters: ${label}`);
      assert.match(label, /^[a-zA-Z0-9]([-a-zA-Z0-9_.]*[a-zA-Z0-9])?$/);
    }
    console.log(`Chart labels valid for ${version}`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
