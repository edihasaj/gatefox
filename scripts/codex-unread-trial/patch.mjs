/** Version-pinned renderer experiment. Produces patched bytes in memory; never writes or signs an app. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createReceiptRegistry } from './receipt-registry.mjs';

export const supportedUnreadTrial = Object.freeze({
  version: '26.1021.31345',
  asset: 'webview/assets/app-initial-feb30b196d11.js',
  assetSha256: '8f4e5fe65617413cabf689afbfc04bc6c24f73a5c0b57d7d0de443942343bd55',
  conversationAsset: 'webview/assets/local-conversation-thread-f8411a03e6c2.js',
  conversationSha256: '4f94f2c3ec4fac892800f78f791c76615f29545f888454dee2f1db7b1f8e183f',
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
  const prefix = `/*${marker}*/const ${marker}=(()=>{${embeddedBridge(bridgeSource)}\nreturn (${createReceiptRegistry.toString()})(installReadStateBridge);})();\n`;
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

/** Gate the stock automatic read with a receipt/history proof, retaining its focus policy. */
export function patchUnreadConversation(source) {
  if (source.includes(marker)) throw Error('Unread trial conversation is already patched');
  const ast = parse(source, 'conversation.mjs');
  // The paired entry point verifies these exact bytes before this structural check is used.
  const hooks = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'xF');
  if (hooks.length !== 1 || hooks[0].parameters.length !== 2 || !hooks[0].body) throw Error('Unread trial automatic-read hook changed');
  const fn = hooks[0], original = fn.getText(ast);
  // Extract the original watcher callback. It retains every native focus and transcript guard.
  const callbacks = [];
  const find = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'watch' &&
        node.arguments.length === 1 && ts.isArrowFunction(node.arguments[0])) callbacks.push(node.arguments[0]);
    ts.forEachChild(node, find);
  };
  find(fn);
  if (callbacks.length !== 1) throw Error('Unread trial watcher changed');
  let callback = callbacks[0].getText(ast);
  const once = (text, before, after) => {
    if (text.split(before).length !== 2) throw Error('Unread trial automatic-read contract changed');
    return text.replace(before, after);
  };
  callback = once(callback, 'y=l(Gf);', `y=l(Gf);l(${marker}History,t);const ${marker}Receipt=${marker}.snapshot(p,t);`);
  callback = once(callback, 'o=v,s=y);return', `o=v,s=y,${marker}Seen=${marker}Receipt?.firstUnread==null?${marker}Receipt?.revision??null:null);return`);
  callback = once(callback, 'a!==_||o!==v)', `a!==_||o!==v||(${marker}Receipt?.firstUnread?.type==='turn'&&${marker}Receipt.revision!==${marker}Seen))`);
  callback = once(callback, 'o=v,s=y,bF(e,t)', `o=v,s=y,${marker}Read(p)`);
  callback = once(callback, '=>{', `=>{if(${marker}Busy)return;${marker}Busy=true;try{`);
  callback = callback.slice(0, -1) + `}finally{${marker}Busy=false}}`;
  const before = original.slice(0, callbacks[0].getStart(ast) - fn.getStart(ast));
  const after = original.slice(callbacks[0].end - fn.getStart(ast));
  let modified = before + `${marker}Evaluate` + after;
  modified = modified.replace('{', `{let ${marker}Seen=null,${marker}Busy=false,${marker}Alive=true,${marker}Pending=false,${marker}Again=false;const ${marker}Read=host=>{if(!${marker}Alive)return;if(!${marker}.snapshot(host,t)){bF(e,t);return}if(${marker}Pending){${marker}Again=true;return}${marker}Pending=true;${marker}.readVisible(host,t,()=>({visible:${marker}Alive&&e.get(Hr)===true&&SF(e.get,t).persistedUnreadHostId===host,generation:e.get(${marker}History,t)}),()=>{bF(e,t)},()=>Cu(e,host).getLoadedConversationHistory(t)).finally(()=>{${marker}Pending=false;if(${marker}Alive&&${marker}Again){${marker}Again=false;${marker}Evaluate({get:e.get})}})};const ${marker}Evaluate=${callback};`);
  modified = once(modified, 'return()=>{u(),l()}', `const ${marker}Stop=${marker}.subscribe(t,host=>{if(SF(e.get,t).persistedUnreadHostId===host)${marker}Evaluate({get:e.get})});return()=>{${marker}Alive=false,${marker}Stop(),u(),l()}`);
  const prefix = `/*${marker}*/import{${marker},${marker}History}from'./${supportedUnreadTrial.asset.split('/').at(-1)}';\n`;
  const output = prefix + source.slice(0, fn.getStart(ast)) + modified + source.slice(fn.end);
  parse(output, 'patched-conversation.mjs');
  return output;
}

/** Validate both immutable chunks before producing any candidate bytes. Does not write an app. */
export function patchPinnedUnreadBundle({ renderer, conversation, bridgeSource, version }) {
  if (version !== supportedUnreadTrial.version ||
      createHash('sha256').update(renderer).digest('hex') !== supportedUnreadTrial.assetSha256 ||
      createHash('sha256').update(conversation).digest('hex') !== supportedUnreadTrial.conversationSha256) {
    throw Error('No verified unread bundle patch exists for these app bytes');
  }
  const patchedRenderer = patchUnreadRenderer(renderer, bridgeSource) + `\nexport{${marker},K2n as ${marker}History};\n`;
  const patchedConversation = patchUnreadConversation(conversation);
  parse(patchedRenderer, 'paired-renderer.mjs');
  return { renderer: patchedRenderer, conversation: patchedConversation };
}
