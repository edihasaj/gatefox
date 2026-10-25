/** Version-pinned renderer experiment. Produces patched bytes in memory; never writes or signs an app. */
import { createHash } from 'node:crypto';
import ts from 'typescript';

export const supportedUnreadTrial = Object.freeze({
  version: '26.1021.31345',
  asset: 'webview/assets/app-initial-feb30b196d11.js',
  assetSha256: '8f4e5fe65617413cabf689afbfc04bc6c24f73a5c0b57d7d0de443942343bd55',
});
const marker = '__hgNativeUnreadTrial';

function parse(source, name) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error('Unread trial source does not parse');
  return ast;
}

function embeddedBridge(source) {
  const ast = parse(source, 'read-state-bridge.mjs');
  const exported = [];
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportAssignment(statement) || ts.isExportDeclaration(statement)) {
      throw new Error('Unread trial bridge must be self-contained');
    }
    const modifiers = statement.modifiers?.filter(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? [];
    for (const modifier of modifiers) exported.push({ statement, modifier });
  }
  if (exported.length !== 1 || !ts.isFunctionDeclaration(exported[0].statement) || exported[0].statement.name?.text !== 'installReadStateBridge') {
    throw new Error('Unread trial bridge must export only installReadStateBridge');
  }
  const { modifier } = exported[0];
  return source.slice(0, modifier.getStart(ast)) + source.slice(modifier.end);
}

/** Locate structural hooks rather than depending on minified class names. A changed or ambiguous app refuses the patch. */
export function patchUnreadRenderer(source, bridgeSource) {
  if (typeof source !== 'string' || typeof bridgeSource !== 'string') throw new Error('Unread trial requires JavaScript source');
  if (source.includes(marker)) throw new Error('Unread trial renderer is already patched');
  const ast = parse(source, 'renderer.mjs');
  const constructors = [], dispatchers = [], readActions = [];
  const walk = node => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const methods = new Set(node.members.map(member => member.name?.getText(ast)));
      if (['saveReadState', 'setConversationUnreadState', 'getThreadHasUnreadTurn'].every(name => methods.has(name))) {
        constructors.push(...node.members.filter(ts.isConstructorDeclaration));
        for (const name of ['markConversationAsRead', 'markConversationAsUnread']) {
          const matches = node.members.filter(member => member.name?.getText(ast) === name);
          if (matches.length !== 1) throw new Error('Unread trial explicit read hooks changed');
          const method = matches[0];
          if (!method.body || method.parameters.length !== 1 || !ts.isIdentifier(method.parameters[0].name)) throw new Error('Unread trial explicit read signature changed');
          readActions.push({method, unread: name === 'markConversationAsUnread'});
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.body && node.parameters.length >= 3) {
      const cases = [];
      const findCases = item => {
        if (item !== node.body && (ts.isFunctionLike(item) || ts.isClassExpression(item) || ts.isClassDeclaration(item))) return;
        if (ts.isCaseClause(item) && ts.isNoSubstitutionTemplateLiteral(item.expression)) cases.push(item.expression.text);
        ts.forEachChild(item, findCases);
      };
      findCases(node.body);
      if (['turn/started', 'turn/completed', 'thread/status/changed', 'item/completed'].every(name => cases.includes(name))) dispatchers.push(node);
    }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  if (constructors.length !== 1 || dispatchers.length !== 1) throw new Error('Unread trial hooks are missing or ambiguous');
  const ctor = constructors[0], dispatcher = dispatchers[0];
  if (!ctor.body || dispatcher.parameters.slice(0, 3).some(parameter => !ts.isIdentifier(parameter.name))) throw new Error('Unread trial hook signature changed');
  const [context, method, params] = dispatcher.parameters.map(parameter => parameter.name.getText(ast));
  const prefix = `/*${marker}*/const ${marker}=(()=>{${embeddedBridge(bridgeSource)}\nconst bridges=new WeakMap();return{install(manager){if(bridges.has(manager))return;const client=manager.threadStore?.params?.requestClient,saved=manager.readState;if(!client||typeof client.sendRequest!=="function"||!saved||typeof saved.has!=="function"||typeof saved.set!=="function"||typeof saved.isReady!=="function"||typeof saved.subscribe!=="function"||!Array.isArray(manager.cleanup)||typeof manager.applySavedConversationReadState!=="function")throw Error("Unread trial client contract changed");const bridge=installReadStateBridge({client,saved,notify:(id,unread)=>manager.applySavedConversationReadState(id,unread)});bridges.set(manager,bridge);manager.cleanup.push(()=>bridge.dispose());},observe(manager,message){bridges.get(manager)?.observe(message);},mark(manager,id,unread){bridges.get(manager)?.mark(id,unread);}};})();\n`;
  const edits = [
    { at: ctor.body.end - 1, text: `;${marker}.install(this);` },
    { at: dispatcher.body.getStart(ast) + 1, text: `${marker}.observe(${context}.manager,{method:${method},params:${params}});` },
    ...readActions.map(({method, unread}) => ({at: method.body.end - 1,
      text: `;${marker}.mark(this,${method.parameters[0].name.getText(ast)},${unread});`})),
  ].sort((left, right) => right.at - left.at);
  let next = source;
  for (const edit of edits) next = next.slice(0, edit.at) + edit.text + next.slice(edit.at);
  next = prefix + next;
  parse(next, 'patched-renderer.mjs');
  return next;
}

/** Official app checks are separate from the pure patcher so synthetic regression fixtures remain possible. */
export function patchPinnedUnreadRenderer(source, bridgeSource, version) {
  if (version !== supportedUnreadTrial.version || createHash('sha256').update(source).digest('hex') !== supportedUnreadTrial.assetSha256) {
    throw new Error('No verified unread trial patch exists for this app version or asset');
  }
  return patchUnreadRenderer(source, bridgeSource);
}
