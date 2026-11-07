import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CardError, componentLines, componentNames, createPlugin } from '../index.js';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const skillPath = (entry) => new URL(`../${entry.path.replace(/^\.\//, '')}`, import.meta.url);

/** Set the plugin up and hand back its tools by name. */
const setUp = async () => {
  const tools = new Map();
  await createPlugin({}).setup({ tools: { register: (tool) => tools.set(tool.name, tool) } });
  return tools;
};

const SPEC = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: 'Open PRs' }, children: ['fields', 'actions'] },
    fields: { type: 'Fields', props: {}, children: ['agent'] },
    agent: { type: 'Field', props: { label: 'agent', value: 4 }, children: [] },
    actions: { type: 'Actions', props: {}, children: ['open'] },
    open: { type: 'LinkButton', props: { label: 'Open', url: 'https://github.com/stratuslabs/agent/pulls' }, children: [] },
  },
};

test('setup registers exactly the tools the manifest declares, at the declared risk', async () => {
  const tools = await setUp();
  assert.deepEqual(
    [...tools.values()].map((tool) => ({ name: tool.name, risk: tool.risk })),
    manifest.stratus.contributes.tools,
  );
});

test('chat.card returns the card as a post: text plus Slack blocks, nothing else', async () => {
  const tools = await setUp();
  const output = await tools.get('chat.card').execute(SPEC);
  assert.deepEqual(Object.keys(output), ['post']);
  assert.equal(typeof output.post.text, 'string');
  assert.match(output.post.text, /Open PRs/);
  assert.deepEqual(output.post.slack.blocks.map((block) => block.type), ['header', 'section', 'actions']);
  const [button] = output.post.slack.blocks[2].elements;
  assert.equal(button.url, 'https://github.com/stratuslabs/agent/pulls');
});

test('chat.card refuses a bad spec with an error the model can act on', async () => {
  const tools = await setUp();
  const bad = structuredClone(SPEC);
  bad.elements.agent.props = { value: 4 };
  bad.elements.open.props.url = 'javascript:alert(1)';
  await assert.rejects(tools.get('chat.card').execute(bad), (error) => {
    assert.ok(error instanceof CardError);
    assert.equal(error.issues.length, 2, error.message);
    assert.match(error.message, /^The card spec has 2 problems\. Fix each and call chat\.card again:\n- /);
    return true;
  });
});

test('the tool description names every component and the skill', async () => {
  const tool = (await setUp()).get('chat.card');
  for (const name of componentNames) {
    assert.ok(tool.description.includes(name), name);
  }
  assert.ok(tool.description.includes(manifest.stratus.contributes.skills[0].id));
  assert.deepEqual(tool.parameters.required, ['root', 'elements']);
});

test('the skill lists the catalog exactly as json-render describes it, Button left out', () => {
  const [entry] = manifest.stratus.contributes.skills;
  const skill = readFileSync(skillPath(entry), 'utf8');
  assert.match(skill, new RegExp(`^---\\nname: ${entry.id}\\ndescription: .+\\n---\\n`));
  const lines = componentLines();
  assert.equal(lines.length, componentNames.length);
  const listed = skill.split('\n').filter((line) => /^- [A-Z][A-Za-z]+: \{/.test(line));
  assert.deepEqual(listed, lines, 'run `npm run skill` and paste its output into the skill');
  assert.ok(!listed.some((line) => line.startsWith('- Button:')));
});

test('the manifest ships what the plugin needs to load', () => {
  for (const file of ['index.js', 'lib/', 'skills/', 'README.md']) {
    assert.ok(manifest.files.includes(file), file);
  }
  assert.equal(manifest.name, '@stratusagent/plugin-json-render');
  assert.equal(manifest.repository.directory, 'json-render');
});

test("the skill's example spec posts as written", async () => {
  const [entry] = manifest.stratus.contributes.skills;
  const skill = readFileSync(skillPath(entry), 'utf8');
  const example = JSON.parse(skill.match(/```json\n([\s\S]+?)\n```/)[1]);
  const output = await (await setUp()).get('chat.card').execute(example);
  assert.deepEqual(output.post.slack.blocks.map((block) => block.type), ['header', 'context', 'section', 'data_table', 'actions']);
});

test("the skill's sample error is the error a missing label gives", async () => {
  const [entry] = manifest.stratus.contributes.skills;
  const skill = readFileSync(skillPath(entry), 'utf8').replace(/\s+/g, ' ');
  const bad = structuredClone(SPEC);
  bad.elements.f1 = { type: 'Field', props: { value: 3 }, children: [] };
  bad.elements.fields.children = ['f1'];
  await assert.rejects((await setUp()).get('chat.card').execute(bad), (error) => {
    assert.equal(error.issues.length, 1);
    assert.ok(skill.includes(`\`${error.issues[0]}\``), error.issues[0]);
    return true;
  });
});
