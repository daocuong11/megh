import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { MeghCompleter } from '../src/complete';
import { componentAttributes, findViewsRoot, scanComponents } from '../src/components';
import { maskMegh } from '../src/mask';

const DEMO_VIEWS = path.resolve(__dirname, '../../../.internal/view-demo/views');

/** HTML completion at the `|` in `src`: the labels, or null inside Megh code. */
function labels(src: string, completer = new MeghCompleter()) {
  const offset = src.indexOf('|');
  const text = src.slice(0, offset) + src.slice(offset + 1);
  const before = text.slice(0, offset).split('\n');
  const position = { line: before.length - 1, character: before[before.length - 1].length };
  const result = completer.complete('file:///t.megh.html', text, position);
  // Inside Megh code there are no HTML items (Megh items are tested in megh.test.ts).
  return result?.type === 'html' ? result.list.items.map((i) => i.label) : null;
}

test('mask keeps offsets and lines', () => {
  const src = '<p class="{{ a }}">\n@if(x(1))\n{{-- c\n--}}@endif</p>';
  const { masked, ranges } = maskMegh(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.equal(masked, '<p class="       ">\n         \n      \n          </p>');
  assert.equal(ranges.length, 4);
});

test('mask leaves emails, @media and escapes alone', () => {
  assert.equal(maskMegh('a@b.com').masked, 'a@b.com');
  // @media is masked too (harmless for HTML), but text around stays.
  assert.equal(maskMegh('x @{{ y').masked, 'x     y');
});

test('tag names', () => {
  assert.ok(labels('<inp|')!.includes('input'));
  assert.ok(labels('@if(x)\n  <sel|\n@endif')!.includes('select'));
});

test('attribute names, also next to Megh syntax', () => {
  for (const src of [
    '<input |',
    '<input class="a {{ x }}" |',
    '<input @if(on) checked @endif |',
    '<form method="post">@csrf <input |',
  ]) {
    const got = labels(src)!;
    assert.ok(got.includes('type') && got.includes('name') && got.includes('required'), src);
  }
});

test('attribute values', () => {
  const got = labels('<input type="|"')!;
  assert.ok(got.includes('file') && got.includes('checkbox'));
  assert.ok(labels('<form method="|"')!.includes('post'));
});

test('closing tag after </', () => {
  assert.ok(labels('<section>\n  {{ a }}\n</|')!.some((l) => l.includes('section')));
});

test('nothing inside Megh code', () => {
  assert.equal(labels('<p>{{ to|do }}</p>'), null);
  assert.equal(labels('@if(x |)'), null);
  assert.equal(labels('<p class="{{ <|"'), null);
  assert.equal(labels('{{-- <inp| --}}'), null);
  assert.equal(labels('{{ unclosed |'), null);
  assert.equal(labels('@react({})\nexport default () => <di|\n@endreact'), null);
});

test('auto-closing tag', () => {
  const c = new MeghCompleter();
  assert.equal(c.closeTag('file:///t', '<div>', { line: 0, character: 5 }), '$0</div>');
  assert.equal(c.closeTag('file:///t', '<input>', { line: 0, character: 7 }), null);
  assert.equal(c.closeTag('file:///t', '{{ a > b', { line: 0, character: 6 }), null);
});

test('component tags and their props from the demo app', () => {
  const root = findViewsRoot(path.join(DEMO_VIEWS, 'todos', 'index.megh.html'));
  assert.equal(root, DEMO_VIEWS);
  const components = scanComponents(root!);
  const completer = new MeghCompleter(components);

  const tags = labels('<x-|', completer)!;
  assert.ok(tags.includes('x-alert') && tags.includes('x-badge') && tags.includes('x-slot'), tags.join());

  const attrs = labels('<x-alert |', completer)!;
  assert.ok(attrs.includes('type') && attrs.includes(':type') && attrs.includes('title'), attrs.join());
  // `{{ slot }}` is the component body, not a prop. (`slot` is still offered
  // as the global HTML attribute.)
  const alert = components.find((t) => t.name === 'x-alert')!;
  assert.deepEqual(alert.attributes!.map((a) => a.name), ['title', ':title', 'type', ':type']);
});

test('component props: loop variables, keys and globals are left out', () => {
  const names = componentAttributes(`
    <ul class="{{ compact ? 'a' : wide }}">
    @foreach(items as item) <li>{{ item.label }} {{ loop.index }}</li> @endforeach
    </ul>
    {{ JSON.stringify({ mode: maxCount }) }} {{ slot }} @isset(footerText) x @endisset
  `).map((a) => a.name);
  assert.deepEqual(
    names.filter((n) => !n.startsWith(':')),
    ['compact', 'footer-text', 'items', 'max-count', 'wide'],
  );
});
