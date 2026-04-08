import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function formatDateJST() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day}`;
}

function randomSlugSuffix() {
  return crypto.randomBytes(4).toString("hex"); // 8 chars
}

const repoRoot = process.cwd();
const articlesDir = path.join(repoRoot, "articles");
const date = formatDateJST();
const slug = `${date.replaceAll("-", "")}-til-${randomSlugSuffix()}`;
const filePath = path.join(articlesDir, `${slug}.md`);

if (!fs.existsSync(articlesDir)) {
  throw new Error(`articles directory not found: ${articlesDir}`);
}
if (fs.existsSync(filePath)) {
  throw new Error(`article already exists: ${filePath}`);
}

const content = `---
title: "${date} TIL"
emoji: "📝"
type: "idea" # tech: 技術記事 / idea: アイデア
topics: ["TIL"]
published: false
---

## 何をした？

- 

## 詰まった点

- 

## 解決（再現できる形で）

- 

## 学び（次にも効く1行）

- 
`;

fs.writeFileSync(filePath, content, "utf8");
console.log(`created: articles/${slug}.md`);

