import { parse } from 'acorn';

const propertyNames = Object.freeze({
  zIndex: 'z-index', pointerEvents: 'pointer-events', alignItems: 'align-items',
  justifyContent: 'justify-content', borderRadius: 'border-radius', fontFamily: 'font-family',
  fontSize: 'font-size', lineHeight: 'line-height', boxShadow: 'box-shadow', userSelect: 'user-select',
});
const closedGuard = 'if (_sticky && _sticky.closed) return;';
const portalCleanup = "if (btn.parentNode === document.body) btn.parentNode.removeChild(btn);";
const restorePortal = 'if (ALLOW_CLOSE_PORTAL && btn.parentNode === document.body) mountBottomClosePortal();';
const supportedMessage = 'This imported script does not support the saved close-button portal safely. Keep the portal off or use a compatible template; existing packages are kept.';

function nodes(root) {
  const result = [], pending = [root];
  while (pending.length) {
    const node = pending.pop(); result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') pending.push(child);
      } else if (value && typeof value.type === 'string') pending.push(value);
    }
  }
  return result;
}
function namedFunction(all, name, required = true) {
  const found = all.filter(node => node.type === 'FunctionDeclaration' && node.id?.name === name);
  if (found.length > 1 || (required && found.length !== 1)) throw new Error(supportedMessage);
  return found[0];
}
const member = (node, object, property) => node?.type === 'MemberExpression'
  && node.object.type === 'Identifier' && node.object.name === object
  && !node.computed && node.property.name === property;
const literal = (node, value) => node?.type === 'Literal' && node.value === value;
const setProperty = node => node?.type === 'CallExpression' && node.callee.type === 'MemberExpression'
  && ((!node.callee.computed && node.callee.property.name === 'setProperty')
    || (node.callee.computed && literal(node.callee.property, 'setProperty')));

/** Only newly generated legacy output with the explicitly saved portal option.
 * Disabled output is byte-identical. Never executes a template or changes a
 * frozen generator, stored source, or previously saved package.
 */
export function patchLegacyStickyPortal(source, enabled) {
  if (!enabled) return source;
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const all = nodes(tree);
  const ensure = namedFunction(all, 'ensureStickyClose');
  const mount = namedFunction(all, 'mountBottomClosePortal');
  namedFunction(all, 'updateBottomClosePortalPosition');
  const top = namedFunction(all, 'ensureStickyTopClose', false);
  const edits = [];
  for (const fn of [ensure, mount, top].filter(Boolean)) {
    for (const node of nodes(fn.body)) {
      if (!setProperty(node)) continue;
      const key = node.arguments[0];
      if (key?.type === 'Literal' && Object.hasOwn(propertyNames, key.value)) {
        edits.push({ start: key.start, end: key.end, value: JSON.stringify(propertyNames[key.value]) });
      }
    }
  }
  const ensureNodes = nodes(ensure.body);
  const buttonDeclarations = ensureNodes.filter(node => node.type === 'VariableDeclarator' && node.id.name === 'btn');
  if (buttonDeclarations.length !== 1) throw new Error(supportedMessage);
  const button = buttonDeclarations[0].init;
  const hostLookup = node => node?.type === 'CallExpression' && member(node.callee, 'host', 'querySelector') && literal(node.arguments[0], '#close_sticky_ad');
  const documentLookup = node => node?.type === 'CallExpression' && member(node.callee, 'document', 'getElementById') && literal(node.arguments[0], 'close_sticky_ad');
  if (hostLookup(button)) {
    edits.push({ start: button.start, end: button.end, value: "document.getElementById('close_sticky_ad') || host.querySelector('#close_sticky_ad')" });
  } else if (!(button?.type === 'LogicalExpression' && button.operator === '||' && documentLookup(button.left) && hostLookup(button.right))) {
    throw new Error(supportedMessage);
  }
  for (const fn of [ensure, mount]) {
    const body = source.slice(fn.body.start, fn.body.end);
    if (!body.includes(closedGuard)) edits.push({ start: fn.body.start + 1, end: fn.body.start + 1, value: '\n  ' + closedGuard });
    const statements = nodes(fn.body).filter(node => node.type === 'ExpressionStatement'
      && node.expression.type === 'AssignmentExpression' && member(node.expression.left, '_sticky', 'closed')
      && literal(node.expression.right, true));
    if (statements.length !== 1) throw new Error(supportedMessage);
    if (!body.includes(portalCleanup)) {
      edits.push({ start: statements[0].end, end: statements[0].end, value: '\n      ' + portalCleanup });
    }
  }
  const keydown = ensureNodes.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'AssignmentExpression' && member(node.expression.left, 'btn', 'onkeydown'));
  if (keydown.length !== 1) throw new Error(supportedMessage);
  if (!source.slice(ensure.start, ensure.end).includes(restorePortal)) {
    edits.push({ start: keydown[0].end, end: keydown[0].end, value: '\n  ' + restorePortal });
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  const checked = parse(output, { ecmaVersion: 'latest', sourceType: 'script' });
  const checkedAll = nodes(checked);
  const checkedFunctions = [namedFunction(checkedAll, 'ensureStickyClose'),
    namedFunction(checkedAll, 'mountBottomClosePortal'), namedFunction(checkedAll, 'ensureStickyTopClose', false)].filter(Boolean);
  if (checkedFunctions.some(fn => nodes(fn.body).some(node => setProperty(node)
      && node.arguments[0]?.type === 'Literal' && Object.hasOwn(propertyNames, node.arguments[0].value)))) {
    throw new Error(supportedMessage);
  }
  return output;
}

const portalAppearance = `/* Tessera legacy portal appearance: position belongs to the script. */
body > #close_sticky_ad {
  box-sizing: border-box;
  width: 28px !important;
  height: 28px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: #fff !important;
  border: 1px solid #888 !important;
  border-radius: 50% !important;
  color: #333 !important;
  cursor: pointer;
  font: 28px/1 Arial, Helvetica, sans-serif !important;
  text-align: center;
  box-shadow: 0 0 0 3px rgba(255,255,255,.98),0 1px 3px rgba(0,0,0,.2) !important;
  user-select: none;
  z-index: 2147483647 !important;
}\n`;

/** Keep external sticky.css from imposing in-host positioning on a body portal. */
export function patchLegacyStickyPortalCss(source, enabled) {
  if (!enabled) return source;
  if (source.includes('/* Tessera legacy portal appearance:')) return source;
  const output = source.replace(/,\s*body\s*>\s*#close_sticky_ad(?=\s*\{)/g, '');
  if (/body\s*>\s*#close_sticky_ad/.test(output)) throw new Error(supportedMessage);
  return output + '\n' + portalAppearance;
}
