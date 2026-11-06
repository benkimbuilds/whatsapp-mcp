import assert from 'node:assert/strict';
import { renderCanned, readStyle } from '../dist/david/style.js';
import { classify } from '../dist/david/intent.js';

delete process.env.OWNER_NAME;
assert.equal(renderCanned('ai_truth', 'en', null, {}), "Yes. I'm the owner's assistant.");
assert.equal(renderCanned('decision_deny', 'en', null, {}), 'The owner declined that.');
process.env.OWNER_NAME = 'Alex';
assert.equal(renderCanned('generic', 'es', null, {}), 'Soy el asistente de Alex. Manda una hora de reunión o un recado.');
assert.equal(renderCanned('decision_edit', 'en', null, { change: 'Friday' }), 'Alex asked to change it: Friday');
// Saved overrides stay literal; {owner} still fills in.
assert.equal(renderCanned('generic', 'en', 'Hi, {owner} is away.', {}), 'Hi, Alex is away.');
// The admin view shows the template, not the filled name.
assert.equal(readStyle(() => null).lines.find((line) => line.id === 'ai_truth').en, "Yes. I'm {owner}'s assistant.");
// Escalation phrases follow OWNER_NAME and generic forms.
assert.equal(classify('can you ask Alex about this?', { isOwnerDm: false }).kind, 'escalate');
assert.equal(classify('please check with the owner', { isOwnerDm: false }).kind, 'escalate');
console.log('PASS: owner name in canned lines and escalation intent');
