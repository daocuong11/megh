import fs from "fs";
import path from "path";

export type DocPage = {
  /** Path without `.md`, e.g. `core-concept/controller`. */
  path: string;
  title: string;
  description: string;
};

type Indexed = DocPage & { body: string; headings: string[] };

export type DocHit = DocPage & { score: number; snippets: string[] };

/**
 * Where the docs are: `dist/docs` in the published package (copied at build
 * time), else the monorepo's `docs/content` when running from source.
 */
export function findDocsDir(): string | null {
  const candidates = [
    process.env.MEGH_DOCS_DIR,
    path.join(__dirname, "docs"),
    path.join(__dirname, "..", "dist", "docs"),
    path.join(__dirname, "..", "..", "..", "docs", "content"),
  ];
  return candidates.find((dir) => dir && fs.existsSync(path.join(dir, "index.md"))) ?? null;
}

/** Split `---` frontmatter (only flat `key: value` lines) from the body. */
function frontmatter(source: string): { meta: Record<string, string>; body: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: source.slice(m[0].length) };
}

export class Docs {
  private pages: Indexed[] | null = null;

  constructor(readonly dir: string | null = findDocsDir()) {}

  get available(): boolean {
    return this.dir !== null;
  }

  private index(): Indexed[] {
    if (this.pages) return this.pages;
    if (!this.dir) return (this.pages = []);
    const dir = this.dir;
    const files = fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => path.join((e as any).parentPath ?? (e as any).path, e.name));
    this.pages = files
      .map((file) => {
        const { meta, body } = frontmatter(fs.readFileSync(file, "utf8"));
        const rel = path.relative(dir, file).split(path.sep).join("/").replace(/\.md$/, "");
        const headings = [...body.matchAll(/^#{1,4}\s+(.+)$/gm)].map((h) => h[1].trim());
        return {
          path: rel,
          title: meta.title || headings[0] || rel,
          description: meta.description ?? "",
          headings,
          body,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    return this.pages;
  }

  list(): DocPage[] {
    return this.index().map(({ path, title, description }) => ({ path, title, description }));
  }

  /** A page's markdown, by path with or without `.md`. */
  read(page: string): string | null {
    const wanted = page.replace(/^\/+/, "").replace(/\.md$/, "").replace(/\/$/, "") || "index";
    const hit = this.index().find((p) => p.path === wanted || p.path === `${wanted}/index`);
    return hit ? `# ${hit.path}\n\n${hit.body.trim()}\n` : null;
  }

  /**
   * Rank pages by the query's words: a match in the title counts most, then
   * headings, description and body. Returns short snippets around body matches.
   */
  search(query: string, limit = 5): DocHit[] {
    const terms = query.toLowerCase().split(/[^a-z0-9@:_.-]+/).filter((t) => t.length > 1);
    if (!terms.length) return [];
    const hits: DocHit[] = [];
    for (const page of this.index()) {
      const title = page.title.toLowerCase();
      const headings = page.headings.join("\n").toLowerCase();
      const description = page.description.toLowerCase();
      const body = page.body.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const inBody = body.split(t).length - 1;
        const s =
          (title.includes(t) ? 10 : 0) +
          (headings.includes(t) ? 5 : 0) +
          (description.includes(t) ? 3 : 0) +
          Math.min(inBody, 10);
        if (s > 0) matched++;
        score += s;
      }
      if (!score) continue;
      score *= matched / terms.length; // pages matching every word rank first
      hits.push({ path: page.path, title: page.title, description: page.description, score, snippets: snippets(page.body, terms) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function snippets(body: string, terms: string[], max = 3): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i].toLowerCase();
    if (!line.trim() || !terms.some((t) => line.includes(t))) continue;
    out.push(lines.slice(Math.max(0, i - 1), i + 2).join("\n").trim());
    i += 2;
  }
  return out;
}
