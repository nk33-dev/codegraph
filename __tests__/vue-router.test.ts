/**
 * Vue Router as a Screens app (`src/resolution/frameworks/vue-router.ts`,
 * `src/resolution/vue-router-synthesizer.ts`): routes read out of
 * `createRouter({ routes: [...] })` and bound to the `.vue` view each names,
 * and the navigation between them — which in Vue is usually written by route
 * NAME rather than by path.
 *
 * The fixture is vue-realworld's shape: a `src/router/index.js` table of lazy
 * views, `router.push({ name })` from the script, `<router-link :to>` from the
 * template. Mirrors `react-router.test.ts`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { buildScreens } from '../src/ui-server/api/screens';
import { parseVueRoutes, vueNavVerb, routeNameInExpression } from '../src/resolution/frameworks/vue-router';
import type { Node } from '../src/types';
import { NODE_KINDS } from '../src/types';

// =============================================================================
// Reading the routes array
// =============================================================================

const ROUTER_SOURCE =
  'import { createRouter, createWebHistory } from "vue-router"\n' +
  'const router = createRouter({\n' +
  '  history: createWebHistory(),\n' +
  '  routes: [\n' +
  '    {\n' +
  '      name: "home",\n' +
  '      path: "/",\n' +
  '      component: () => import("@/views/Home")\n' +
  '    },\n' +
  '    {\n' +
  '      name: "login",\n' +
  '      path: "/login",\n' +
  '      component: () => import("@/views/Login")\n' +
  '    },\n' +
  '    {\n' +
  '      name: "settings",\n' +
  '      path: "/settings",\n' +
  '      component: () => import("@/views/Settings"),\n' +
  '      meta: { requiresAuth: true }\n' +
  '    },\n' +
  '    {\n' +
  '      name: "profile",\n' +
  '      path: "/profile/:username",\n' +
  '      component: Profile,\n' +
  '      children: [\n' +
  '        { path: "favorites", component: Favorites }\n' +
  '      ]\n' +
  '    }\n' +
  '  ]\n' +
  '})\n' +
  'export default router\n';

describe('vue-router: parseVueRoutes', () => {
  const entries = parseVueRoutes(ROUTER_SOURCE);

  it('gives every entry its OWN name — the name is written above the path it belongs to', () => {
    expect(entries.map((e) => [e.name, e.path])).toEqual([
      ['home', '/'],
      ['login', '/login'],
      ['settings', '/settings'],
      ['profile', '/profile/:username'],
    ]);
  });

  it('reads the component from a lazy import and from an identifier', () => {
    expect(entries.map((e) => e.component)).toEqual(['Home', 'Login', 'Settings', 'Profile']);
  });

  it('skips a child route, whose path is relative to a parent this does not compose', () => {
    expect(entries.some((e) => e.path === 'favorites')).toBe(false);
  });

  it('is nothing on a file that declares no routes', () => {
    expect(parseVueRoutes('export const paths = [{ path: "/x" }]\n')).toEqual([]);
    expect(parseVueRoutes('const x = 1\n')).toEqual([]);
  });
});

describe('vue-router: navigation call names', () => {
  it.each([
    ['router.push', 'push'],
    ['router.replace', 'replace'],
    ['$router.push', 'push'],
    ['navigateTo', 'navigateTo'],
  ])('%s → %s', (name, verb) => {
    expect(vueNavVerb(name)).toBe(verb);
  });

  it.each(['push', 'replace', 'paths.push', 'list.replace', 'go', 'back'])(
    '%s is not a navigation — an unqualified push is an array’s',
    (name) => {
      expect(vueNavVerb(name)).toBeNull();
    }
  );

  it('reads the route name out of an object destination, and nothing out of a path one', () => {
    expect(routeNameInExpression('{ name: "login" }')).toBe('login');
    expect(routeNameInExpression("{ name: 'profile', params: { username } }")).toBe('profile');
    expect(routeNameInExpression('{ path: "/", query }')).toBeNull();
    expect(routeNameInExpression("'/login'")).toBeNull();
  });
});

// =============================================================================
// The whole picture, indexed
// =============================================================================

describe('vue-router: a routed app end to end', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  function write(rel: string, content: string): void {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-router-'));
    write('package.json', JSON.stringify({ name: 'conduit', dependencies: { vue: '3', 'vue-router': '4' } }));
    write(
      'src/router/index.js',
      'import { createRouter, createWebHistory } from "vue-router"\n' +
        'const router = createRouter({\n' +
        '  history: createWebHistory(),\n' +
        '  routes: [\n' +
        '    { name: "home", path: "/", component: () => import("@/views/Home") },\n' +
        '    { name: "login", path: "/login", component: () => import("@/views/Login") },\n' +
        '    { name: "register", path: "/register", component: () => import("@/views/Register") },\n' +
        '    { name: "settings", path: "/settings", component: () => import("@/views/Settings") },\n' +
        '    { name: "profile", path: "/profile/:username", component: () => import("@/views/Profile") }\n' +
        '  ]\n' +
        '})\n' +
        'export default router\n'
    );
    write(
      'src/views/Home.vue',
      '<template>\n' +
        '  <div><TheHeader /></div>\n' +
        '</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "vue-router"\n' +
        'import TheHeader from "@/components/TheHeader.vue"\n' +
        'const router = useRouter()\n' +
        'function goTo(tag) {\n' +
        '  router.push({ path: "/", query: { tag } })\n' +
        '}\n' +
        'function goHome() {\n' +
        '  navigateTo("/settings")\n' +
        '}\n' +
        '</script>\n'
    );
    write(
      'src/views/Login.vue',
      '<template>\n' +
        '  <form @submit="submit"><router-link :to="{ name: \'register\' }">Need an account?</router-link></form>\n' +
        '</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "vue-router"\n' +
        'const router = useRouter()\n' +
        'function submit() {\n' +
        '  login().then(() => router.push({ name: "home" }))\n' +
        '}\n' +
        '</script>\n'
    );
    // The handle a composable returns is the app's to name, so `nav.push` must
    // reach its route. `takeOther`'s parameter of the same name must not: the
    // binding in scope is all that separates them.
    write(
      'src/views/Register.vue',
      '<template>\n' +
        '  <router-link to="/login">Have an account?</router-link>\n' +
        '</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "vue-router"\n' +
        'const nav = useRouter()\n' +
        'function backToLogin() {\n' +
        '  nav.push("/login")\n' +
        '}\n' +
        'function takeOther(nav) {\n' +
        '  nav.push("/login")\n' +
        '}\n' +
        '</script>\n'
    );
    write(
      'src/views/Settings.vue',
      '<template>\n' +
        '  <button @click="save">Save</button>\n' +
        '</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "vue-router"\n' +
        'const router = useRouter()\n' +
        'const target = "/nowhere"\n' +
        'function save(user) {\n' +
        '  router.push({ name: "profile", params: { username: user.username } })\n' +
        '}\n' +
        'function bail() {\n' +
        '  router.push(target)\n' +
        '}\n' +
        '</script>\n'
    );
    write(
      'src/views/Profile.vue',
      '<template>\n  <div>Profile</div>\n</template>\n<script setup>\nconst x = 1\n</script>\n'
    );
    write(
      'src/components/TheHeader.vue',
      '<template>\n' +
        '  <nav>\n' +
        '    <router-link :to="{ name: \'home\' }">Home</router-link>\n' +
        '    <router-link to="/settings">Settings</router-link>\n' +
        '    <a href="https://example.com">Elsewhere</a>\n' +
        '  </nav>\n' +
        '</template>\n' +
        '<script setup>\nconst y = 1\n</script>\n'
    );
    // The precision floor: an array's `push` with a string that IS a route.
    write('src/utils/trail.js', 'export function trail() {\n  const paths = []\n  paths.push("/login")\n  return paths\n}\n');
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const route = (name: string): Node => {
    const r = cg.getNodesByKind('route').find((r) => r.name === name);
    if (!r) throw new Error(`no route ${name}: ${cg.getNodesByKind('route').map((r) => r.name).join(', ')}`);
    return r;
  };
  const sym = (name: string): Node => {
    const n = cg.getNodesByName(name).find((n) => n.kind !== 'route' && n.kind !== 'file' && n.kind !== 'import');
    if (!n) throw new Error(`no symbol ${name}`);
    return n;
  };
  const navs = (from: Node) => cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'navigates');
  const hrefs = (from: Node) =>
    navs(from)
      .map((e) => (e.metadata as Record<string, unknown>).href as string)
      .sort();

  it('names every route in the table and binds it to the .vue view it names', () => {
    expect(cg.getNodesByKind('route').map((r) => r.name).sort()).toEqual([
      '/',
      '/login',
      '/profile/:username',
      '/register',
      '/settings',
    ]);
    // The binding is a `calls` edge to the component, never the same-named
    // symbol a `references` edge would have found in the JS half of the app.
    const bound = cg.getOutgoingEdges(route('/login').id).find((e) => e.kind === 'calls');
    expect(cg.getNode(bound!.target)).toMatchObject({ name: 'Login', kind: 'component', filePath: 'src/views/Login.vue' });
  });

  it('router.push({ name }) reaches the route with that name', () => {
    const login = navs(sym('submit'));
    expect(login).toHaveLength(1);
    expect(login[0]!.target).toBe(route('/').id);
    expect(login[0]!.metadata).toMatchObject({ href: 'home', navMethod: 'push', by: 'name' });
    const save = navs(sym('save'));
    expect(save[0]!.target).toBe(route('/profile/:username').id);
    expect(save[0]!.metadata).toMatchObject({ href: 'profile', by: 'name' });
  });

  it('router.push({ path }) reaches the route with that path', () => {
    const goTo = navs(sym('goTo'));
    expect(goTo).toHaveLength(1);
    expect(goTo[0]!.target).toBe(route('/').id);
    expect(goTo[0]!.metadata).toMatchObject({ href: '/', navMethod: 'push' });
    expect((goTo[0]!.metadata as Record<string, unknown>).by).toBeUndefined();
  });

  it('a <router-link> navigates from the component that renders it, by name or by path', () => {
    expect(hrefs(sym('TheHeader'))).toEqual(['/settings', 'home']);
    const byHref = new Map(navs(sym('TheHeader')).map((e) => [(e.metadata as Record<string, unknown>).href, e]));
    expect(byHref.get('home')!.target).toBe(route('/').id);
    expect(byHref.get('home')!.provenance).toBe('heuristic');
    expect(byHref.get('home')!.metadata).toMatchObject({ synthesizedBy: 'vue-router-link', navMethod: 'link', by: 'name' });
    expect(byHref.get('/settings')!.target).toBe(route('/settings').id);
    expect(hrefs(sym('Register'))).toEqual(['/login']);
  });

  it('a destination nothing declares is left unresolved, and an array’s push is never claimed', () => {
    // `router.push(target)` where target is "/nowhere" — a real string, no route.
    expect(navs(sym('bail'))).toEqual([]);
    expect(navs(sym('trail'))).toEqual([]);
  });

  it('navigateTo reaches the route it names', () => {
    // A Nuxt auto-import AND a navigation verb, so the resolver order decides
    // it: `vueResolver` answering at 1.0 ends the loop before this reaches
    // `vueRouterResolver`.
    const goHome = navs(sym('goHome'));
    expect(goHome).toHaveLength(1);
    expect(goHome[0]!.target).toBe(route('/settings').id);
    expect(goHome[0]!.metadata).toMatchObject({ href: '/settings', navMethod: 'navigateTo' });
  });

  it('a handle the app named itself still navigates, because it is bound to useRouter()', () => {
    const back = navs(sym('backToLogin'));
    expect(back).toHaveLength(1);
    expect(back[0]!.target).toBe(route('/login').id);
    expect(back[0]!.metadata).toMatchObject({ href: '/login', navMethod: 'push' });
  });

  it('a parameter of the same name shadows the handle and claims nothing', () => {
    // `takeOther(nav)` pushes the same real path; only the binding in scope
    // separates it from `backToLogin`.
    expect(navs(sym('takeOther'))).toEqual([]);
  });

  it('framework built-ins are consumed without drawing a self-edge', () => {
    // `defineProps`/`useRouter` have nothing to point at, so consuming the
    // reference must not leave an edge to the symbol that mentions it.
    const nodes = NODE_KINDS.flatMap((kind) => cg.getNodesByKind(kind));
    const selfEdges = cg
      .getOutgoingEdgesFrom(nodes.map((n) => n.id))
      .filter((e) => e.source === e.target);
    expect(selfEdges).toEqual([]);
  });

  it('lands on the Screens tab as transitions between screens', async () => {
    const screens = await buildScreens(cg, tmpDir);
    expect(screens.routed).toBe(true);
    expect(screens.screens.map((s) => s.path).sort()).toEqual(['/', '/login', '/profile/:username', '/register', '/settings']);
    const at = (p: string) => screens.screens.find((s) => s.path === p)!;
    expect(at('/login').component?.name).toBe('Login');
    const toProfile = screens.links.find((l) => l.from === at('/settings').id && l.to === at('/profile/:username').id)!;
    expect(toProfile).toBeDefined();
    expect(toProfile.via.map((v) => v.name)).toEqual(['save']);
    expect(toProfile.sites[0]).toMatchObject({ href: 'profile', method: 'push' });
    expect(screens.links.find((l) => l.from === at('/login').id && l.to === at('/register').id)).toBeDefined();
    expect(screens.dropped).toBe(0);
  });
});

// =============================================================================
// A composable the repo defines itself, under a name Nuxt also auto-imports
// =============================================================================

// `useRouter` is a Nuxt auto-import and also a name a project may define. The
// auto-import must not win when the repo has its own definition.
describe('vue: a repo-defined composable outranks the auto-import of its name', () => {
  let tmpDir: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vue-composable-'));
    const write = (rel: string, content: string): void => {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    write('package.json', JSON.stringify({ name: 'app', dependencies: { vue: '3', 'vue-router': '4' } }));
    write(
      'src/composables/useRouter.ts',
      'import { useRouter as vueRouter } from "vue-router"\n' +
        'export function useRouter() {\n' +
        '  return vueRouter()\n' +
        '}\n'
    );
    write(
      'src/views/Search.vue',
      '<template>\n  <div>Search</div>\n</template>\n' +
        '<script setup>\n' +
        'import { useRouter } from "../composables/useRouter"\n' +
        'const nav = useRouter()\n' +
        '</script>\n'
    );
    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('binds the call to the repo’s composable instead of consuming it as a built-in', () => {
    const defined = cg
      .getNodesByName('useRouter')
      .filter((n) => n.kind === 'function' && n.filePath === 'src/composables/useRouter.ts');
    expect(defined).toHaveLength(1);
    expect(cg.getIncomingEdges(defined[0]!.id).some((e) => e.kind === 'calls')).toBe(true);
  });
});
