import fs from 'node:fs';
import path from 'node:path';

function replaceInDir(dir: string) {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      replaceInDir(fullPath);
    } else if (file.endsWith('.ts')) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      content = content.replace(/\.ts"/g, '.js"');
      content = content.replace(/\.ts'/g, ".js'");
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }
}
replaceInDir('src');
console.log('Imports updated to .js successfully.');
