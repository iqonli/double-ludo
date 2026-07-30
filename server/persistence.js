'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  ensureDirectory(directory);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function quarantineBrokenFile(filePath, error) {
  if (!fs.existsSync(filePath)) return null;
  const brokenPath = `${filePath}.broken-${Date.now()}`;
  try {
    fs.renameSync(filePath, brokenPath);
    console.error(`自动存档无法读取，已移动到：${brokenPath}`);
  } catch (renameError) {
    console.error('无法隔离损坏的自动存档：', renameError);
  }
  if (error) console.error(error);
  return brokenPath;
}

module.exports = { ensureDirectory, atomicWriteJson, loadJson, quarantineBrokenFile };
