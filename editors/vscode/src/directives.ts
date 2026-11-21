/**
 * What the extension knows about Megh's built-in directives: docs for hover,
 * and block structure for validation and formatting.
 * Keep in sync with packages/core/src/view/directives.ts.
 */
export type DirectiveDoc = { syntax: string; doc: string };

export const DIRECTIVES: Record<string, DirectiveDoc> = {
  if: { syntax: '@if(condition) … @elseif(condition) … @else … @endif', doc: 'Conditional.' },
  elseif: { syntax: '@elseif(condition)', doc: 'Another branch of `@if`.' },
  else: { syntax: '@else', doc: 'Last branch of `@if` or `@unless`.' },
  endif: { syntax: '@endif', doc: 'Closes `@if`.' },
  unless: { syntax: '@unless(condition) … @endunless', doc: '`@if (!condition)`.' },
  endunless: { syntax: '@endunless', doc: 'Closes `@unless`.' },
  isset: {
    syntax: '@isset(a.b.c) … @endisset',
    doc: 'True if the path exists and is not null. Never throws, even if `a` is not defined.',
  },
  endisset: { syntax: '@endisset', doc: 'Closes `@isset`.' },
  foreach: {
    syntax: '@foreach(items as item) … @endforeach\n@foreach(obj as key => value) … @endforeach',
    doc: 'Loops over arrays, Maps, Sets, iterables and plain objects. Inside, `loop` has `index`, `iteration`, `first`, `last`, `count`, `remaining`, `even`, `odd`, `depth` and `parent`.',
  },
  endforeach: { syntax: '@endforeach', doc: 'Closes `@foreach`.' },
  for: { syntax: '@for(let i = 0; i < n; i++) … @endfor', doc: 'A plain JavaScript `for` loop.' },
  endfor: { syntax: '@endfor', doc: 'Closes `@for`.' },
  while: { syntax: '@while(condition) … @endwhile', doc: 'A plain JavaScript `while` loop.' },
  endwhile: { syntax: '@endwhile', doc: 'Closes `@while`.' },
  break: { syntax: '@break / @break(condition)', doc: 'Leaves the current loop (when `condition` is true).' },
  continue: { syntax: '@continue / @continue(condition)', doc: 'Skips to the next iteration (when `condition` is true).' },
  js: { syntax: '@js(const x = 1)\n@js … @endjs', doc: 'Raw JavaScript, run while rendering.' },
  endjs: { syntax: '@endjs', doc: 'Closes `@js`.' },
  json: { syntax: '@json(value)', doc: 'Prints `value` as JSON that is safe inside `<script>`.' },
  csrf: { syntax: '@csrf', doc: 'Hidden `_token` input with `csrfToken` from the view data.' },
  method: {
    syntax: "@method('PUT')",
    doc: 'Hidden `_method` input. With `app.useMethodOverride()`, a form POST reaches the PUT, PATCH or DELETE route. Put it before any file input.',
  },
  include: { syntax: "@include('partials.nav', { extra })", doc: 'Renders another view here, with this view\'s data plus `extra`.' },
  extends: { syntax: "@extends('layouts.app')", doc: 'Renders this view inside a layout. Fill the layout with `@section`s.' },
  section: {
    syntax: "@section('name') … @endsection\n@section('title', 'Home')",
    doc: 'Defines a section for the layout. With a second argument, a one-line section.',
  },
  endsection: { syntax: '@endsection', doc: 'Closes `@section`.' },
  show: { syntax: "@section('sidebar') … @show", doc: 'Closes a section and prints it at once (in layouts).' },
  yield: { syntax: "@yield('name', 'default')", doc: 'Prints a section, or `default` when no view defined it.' },
  parent: { syntax: '@parent', doc: "Inside a child's section: inserts the layout's version of it." },
  push: { syntax: "@push('scripts') … @endpush", doc: 'Adds content to a stack, printed by `@stack`.' },
  endpush: { syntax: '@endpush', doc: 'Closes `@push`.' },
  stack: { syntax: "@stack('scripts')", doc: 'Prints everything pushed to the stack.' },
  component: {
    syntax: "@component('alert', { type: 'error' }) … @endcomponent",
    doc: 'Renders `components/alert.megh.html`. Usually written as `<x-alert type="error">`.',
  },
  endcomponent: { syntax: '@endcomponent', doc: 'Closes `@component`.' },
  slot: { syntax: "@slot('title') … @endslot", doc: 'Named slot of the component. Usually written as `<x-slot:title>`.' },
  endslot: { syntax: '@endslot', doc: 'Closes `@slot`.' },
  react: {
    syntax: '@react(props) … @endreact',
    doc: 'A React component, compiled on the server and mounted in the browser. The body is a JSX module with a default export.',
  },
  endreact: { syntax: '@endreact', doc: 'Closes `@react`.' },
};

/** Block openers and the directives that close them. */
export const BLOCKS: Record<string, string[]> = {
  if: ['endif'],
  unless: ['endunless'],
  isset: ['endisset'],
  foreach: ['endforeach'],
  for: ['endfor'],
  while: ['endwhile'],
  section: ['endsection', 'show'],
  push: ['endpush'],
  component: ['endcomponent'],
  slot: ['endslot'],
};

/** Branch directives and the blocks they belong to. */
export const BRANCHES: Record<string, string[]> = {
  elseif: ['if'],
  else: ['if', 'unless'],
};

export const CLOSERS = new Set(Object.values(BLOCKS).flat());

/** `@section('title', 'Home')` is one line; `@section('content')` opens a block. */
export function opensBlock(name: string, args: string | undefined): boolean {
  if (!(name in BLOCKS)) return false;
  if (name === 'section' && args !== undefined && hasTopLevelComma(args)) return false;
  return true;
}

export function hasTopLevelComma(args: string) {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < args.length && args[i] !== c) {
        if (args[i] === '\\') i++;
        i++;
      }
    } else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return true;
  }
  return false;
}

export const LOOP_PROPS: Record<string, string> = {
  index: 'Index of the current item, from 0.',
  iteration: 'Number of the current item, from 1.',
  first: 'True for the first item.',
  last: 'True for the last item.',
  count: 'Number of items.',
  remaining: 'Items left after this one.',
  even: 'True when `iteration` is even.',
  odd: 'True when `iteration` is odd.',
  depth: 'Nesting level of the loop, from 1.',
  parent: '`loop` of the enclosing `@foreach`, if any.',
};
