const fs = require('node:fs');
const path = require('node:path');

// Normalize only the text files covered by format:check. Leave all other
// whitespace intact so Prettier still rejects genuine formatting problems.
function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? testFiles(file) : entry.name.endsWith('.ts') ? [file] : [];
  });
}

const files = [
  ...testFiles('tests').filter((file) => file !== path.join('tests', 'helpers', 'synthetic-ct.ts')),
  'playwright.config.ts',
  'package.json',
  'tsconfig.json',
  '.prettierrc.json',
  'README.md',
  'scripts/uat-results-data.json',
];
let changed = 0;
for (const file of files) {
  const original = fs.readFileSync(file);
  const normalized = Buffer.from(original.toString('utf8').replace(/\r\n/g, '\n'));
  if (!original.equals(normalized)) {
    fs.writeFileSync(file, normalized);
    changed++;
  }
}
console.log(`Normalized CRLF to LF in ${changed} of ${files.length} checked text files.`);
