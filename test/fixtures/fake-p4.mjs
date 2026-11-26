import fs from 'node:fs/promises';
import path from 'node:path';

const registryPath = process.env.FAKE_P4_REGISTRY;
if (!registryPath) throw new Error('FAKE_P4_REGISTRY is required');
const argv = process.argv.slice(2);
const delayMs = Number(process.env.AGENT_WORKSPACE_TEST_P4_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
let input = '';
for await (const chunk of process.stdin) input += chunk;

async function withRegistry(callback) {
  const lock = `${registryPath}.lock`;
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    const state = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    const result = await callback(state);
    const temporary = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(temporary, registryPath);
    return result;
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

function parseForm(text) {
  const form = {};
  let active = null;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/.exec(line);
    if (match) {
      active = match[1];
      form[active] = match[2] ?? '';
    } else if (active && line.startsWith('\t')) form[active] += `${form[active] ? '\n' : ''}${line.slice(1)}`;
  }
  return form;
}

function formatForm(form) {
  const lines = [];
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === '') continue;
    const parts = String(value).split('\n');
    if (parts.length === 1) lines.push(`${key}: ${value}`);
    else lines.push(`${key}:`, ...parts.map((part) => `\t${part}`));
  }
  return `${lines.join('\n')}\n`;
}

function tagged(record) {
  return `${Object.entries(record).map(([key, value]) => `... ${key} ${String(value).replace(/\r?\n/g, '\\n')}`).join('\n')}\n\n`;
}

function fail(message) {
  process.stdout.write(tagged({ code: 'error', severity: '3', data: message }));
  process.exitCode = 1;
}

function takeOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function takeFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

let index = argv[0] === '-ztag' ? 1 : 0;
let selectedClient = null;
while (argv[index]?.startsWith('-')) {
  if (argv[index] === '-c') {
    selectedClient = argv[index + 1];
    index += 2;
    continue;
  }
  break;
}
const command = argv[index];
const args = argv.slice(index + 1);

await withRegistry(async (state) => {
  state.log ??= [];
  state.log.push({ argv: [...argv], command, args: [...args], selectedClient, inputBytes: Buffer.byteLength(input), secretEnvKeys: Object.keys(process.env).filter((key) => /^p4(passwd|tickets|config|trust|loginsso|enviro)$/i.test(key)) });
  const configuredFault = state.faults?.[command];
  const fault = configuredFault && (!configuredFault.args0 || configuredFault.args0 === args[0]) ? configuredFault : null;
  if (fault?.times > 0 && !fault.afterCreate && !fault.afterMutation) {
    fault.times -= 1;
    fail(fault.error ?? `injected ${command} failure`);
    return;
  }

  if (command === 'info') {
    if (state.requiredPort !== undefined && process.env.P4PORT !== state.requiredPort) {
      return fail('configured endpoint is unavailable');
    }
    if (state.endpointFaults?.[process.env.P4PORT]?.times > 0) {
      const endpointFault = state.endpointFaults[process.env.P4PORT];
      endpointFault.times -= 1;
      return fail(endpointFault.error ?? 'configured endpoint fault');
    }
    process.stdout.write(tagged({
      userName: process.env.P4USER ?? state.user ?? 'agent',
      serverAddress: state.serverAddress ?? process.env.P4PORT ?? 'fake:1666',
      serverRoot: state.serverRoot ?? '/fake/server/root',
      serverServices: state.serverServices ?? 'standard',
      serverID: state.serverID ?? 'fake-server-id',
      caseHandling: state.caseHandling ?? 'sensitive',
      unicode: state.unicode ?? 'enabled',
    }));
    return;
  }

  if (command === 'set') {
    if (args.length !== 2 || args[0] !== '-q' || !/^P4(?:PORT|CHARSET|TICKETS|TRUST)$/.test(args[1])) {
      return fail('fake set requires -q and one permitted setting name');
    }
    const name = args[1];
    if (state.settingRecords?.[name]) {
      for (const record of state.settingRecords[name]) process.stdout.write(tagged(record));
    } else if (state.settings?.[name] !== undefined) process.stdout.write(`${name}=${state.settings[name]}\n`);
    return;
  }

  if (command === 'clients') {
    const pattern = takeOption(args, '-e');
    for (const form of Object.values(state.clients).filter((entry) => entry.Client === pattern)) process.stdout.write(tagged({ client: form.Client, Root: form.Root }));
    return;
  }

  if (command === 'client') {
    if (args[0] === '-o') {
      const name = args[1] ?? selectedClient;
      const form = state.clients[name] ?? { Client: name, Root: '', Options: 'noallwrite noclobber nocompress unlocked nomodtime normdir', SubmitOptions: 'submitunchanged', Description: `Created by ${process.env.P4USER ?? 'unknown'}.` };
      process.stdout.write(tagged({ data: formatForm(form) }));
      return;
    }
    if (args[0] === '-i') {
      const form = parseForm(input);
      if (!form.Client) return fail('Client form has no Client field');
      state.clients[form.Client] = form;
      state.have[form.Client] ??= {};
      if (fault?.times > 0 && fault.afterCreate) {
        fault.times -= 1;
        fail(fault.error ?? 'connection dropped after create');
        return;
      }
      process.stdout.write(tagged({ client: form.Client, action: 'saved' }));
      return;
    }
    if (args[0] === '-d') {
      const name = args[1];
      if (!state.clients[name]) return fail(`Client '${name}' does not exist.`);
      if (state.opened.some((entry) => entry.client === name)) return fail(`Client '${name}' has open files.`);
      if (Object.values(state.changes).some((entry) => entry.Client === name && entry.Status === 'pending')) return fail(`Client '${name}' has pending changes.`);
      delete state.clients[name];
      delete state.have[name];
      if (fault?.times > 0 && fault.afterMutation) {
        fault.times -= 1;
        fail(fault.error ?? 'connection dropped after client deletion');
        return;
      }
      process.stdout.write(tagged({ client: name, action: 'deleted' }));
      return;
    }
  }

  if (command === 'where') {
    for (const depotFile of args) {
      const root = state.clients[selectedClient]?.Root;
      if (!root) return fail(`${depotFile} - must refer to client '${selectedClient}'.`);
      const mappedPath = state.where?.[selectedClient]?.[depotFile] ?? path.join(root, path.basename(depotFile));
      process.stdout.write(tagged({ depotFile, clientFile: `//${selectedClient}/${path.basename(depotFile)}`, path: mappedPath }));
    }
    return;
  }

  if (command === 'opened') {
    const client = takeOption(args, '-C') ?? selectedClient;
    const change = takeOption(args, '-c');
    const found = state.opened.filter((entry) => entry.client === client && (!change || String(entry.change ?? 'default') === change));
    if (found.length === 0) return fail('File(s) not opened on this client.');
    for (const opened of found) process.stdout.write(tagged({ depotFile: opened.depotFile, haveRev: state.have[client]?.[opened.depotFile] ?? '', action: opened.action, change: opened.change ?? 'default', client }));
    return;
  }

  if (command === 'changes') {
    takeOption(args, '-s');
    const client = takeOption(args, '-c');
    const user = takeOption(args, '-u');
    for (const change of Object.values(state.changes).filter((entry) => entry.Client === client && entry.Status === 'pending' && (!user || entry.User === user))) {
      process.stdout.write(tagged({ change: change.Change, client: change.Client, user: change.User, status: change.Status, desc: change.Description }));
    }
    return;
  }

  if (command === 'change') {
    if (args[0] === '-o') {
      const number = args[1];
      const form = state.changes[number];
      if (!form) return fail(`Change ${number} unknown.`);
      process.stdout.write(tagged({ data: formatForm(form) }));
      return;
    }
    if (args[0] === '-i') {
      const form = parseForm(input);
      if (Object.hasOwn(form, 'Files')) return fail('package-created change form must not contain Files');
      const number = String(state.nextChange++);
      state.changes[number] = { ...form, Change: number, Status: 'pending' };
      if (fault?.times > 0 && fault.afterCreate) {
        fault.times -= 1;
        fail(fault.error ?? 'connection dropped after create');
        return;
      }
      process.stdout.write(tagged({ change: number, action: 'created' }));
      return;
    }
    if (args[0] === '-d') {
      const number = args[1];
      if (!state.changes[number]) return fail(`Change ${number} does not exist.`);
      if (state.opened.some((entry) => String(entry.change) === number)) return fail(`Change ${number} has open files.`);
      if (state.shelves[number]) return fail(`Change ${number} has shelved files.`);
      delete state.changes[number];
      if (fault?.times > 0 && fault.afterMutation) {
        fault.times -= 1;
        fail(fault.error ?? 'connection dropped after change deletion');
        return;
      }
      process.stdout.write(tagged({ change: number, action: 'deleted' }));
      return;
    }
  }

  if (command === 'have') {
    for (const depotFile of args) {
      const revision = state.have[selectedClient]?.[depotFile];
      if (revision === undefined) continue;
      process.stdout.write(tagged({ depotFile, haveRev: String(revision), path: `${state.clients[selectedClient]?.Root ?? ''}/${path.basename(depotFile)}` }));
    }
    if (!args.some((depotFile) => state.have[selectedClient]?.[depotFile] !== undefined)) return fail(`${args[0]} - file(s) not on client.`);
    return;
  }

  if (command === 'sync') {
    if (args[0] !== '-k' || args[1] !== '-L') return fail('fake only permits metadata-only sync -k -L');
    state.have[selectedClient] ??= {};
    for (const spec of args.slice(2)) {
      const match = /^(\/\/.*)#(\d+)$/.exec(spec);
      if (!match) return fail(`invalid exact sync spec '${spec}'`);
      const revision = state.faults?.wrongSyncPath === match[1] ? String(Number(match[2]) + 1) : match[2];
      state.have[selectedClient][match[1]] = revision;
      process.stdout.write(tagged({ depotFile: match[1], rev: revision, action: 'updated' }));
    }
    return;
  }

  if (['edit', 'add', 'delete'].includes(command)) {
    const change = takeOption(args, '-c') ?? 'default';
    for (const depotFile of args) {
      if (state.opened.some((entry) => entry.client === selectedClient && entry.depotFile === depotFile)) return fail(`${depotFile} - already opened on this client.`);
      state.opened.push({ client: selectedClient, depotFile, action: command, change });
      process.stdout.write(tagged({ depotFile, change, action: command }));
    }
    return;
  }

  if (command === 'reopen') {
    const change = takeOption(args, '-c');
    for (const depotFile of args) {
      const opened = state.opened.find((entry) => entry.client === selectedClient && entry.depotFile === depotFile);
      if (!opened) return fail(`${depotFile} is not open on client ${selectedClient}`);
      opened.change = change;
      process.stdout.write(tagged({ depotFile, change, action: opened.action }));
    }
    return;
  }

  if (command === 'describe') {
    const shelf = takeFlag(args, '-S') ? takeOption(args, '-s') : null;
    const files = state.shelves[shelf];
    if (!files) {
      process.stdout.write(tagged({ change: shelf, status: 'pending' }));
      return;
    }
    const record = { change: shelf };
    files.forEach((file, fileIndex) => {
      record[`depotFile${fileIndex}`] = file.depotFile;
      if (file.describeShape !== 'missing-action') record[`action${fileIndex}`] = file.action;
      record[`rev${fileIndex}`] = file.rev ?? '1';
      record[`type${fileIndex}`] = file.type ?? 'text';
      if (file.movedFile) record[`movedFile${fileIndex}`] = file.movedFile;
      if (file.movedRev) record[`movedRev${fileIndex}`] = file.movedRev;
    });
    process.stdout.write(tagged(record));
    if (state.describeShape === 'duplicate-first' && files[0]) {
      process.stdout.write(tagged({ depotFile0: files[0].depotFile, action0: files[0].action, rev0: files[0].rev ?? '1', type0: files[0].type ?? 'text' }));
    }
    return;
  }

  if (command === 'fstat') {
    const change = takeOption(args, '-e');
    takeFlag(args, '-Rs');
    takeFlag(args, '-Ol');
    const files = state.shelves[change];
    if (!files) return fail(`Change ${change} has no shelved files.`);
    for (const file of files) {
      const digest = Object.hasOwn(file, 'digest') ? file.digest : `digest:${file.depotFile}:${file.action}:${file.rev ?? '1'}`;
      const fileSize = Object.hasOwn(file, 'fileSize') ? file.fileSize : String(Buffer.byteLength(`${file.depotFile}:${file.action}`));
      const type = file.type ?? 'text';
      const shape = file.fstatShape ?? state.fstatShape ?? 'direct';
      let record;
      const shelfIdentity = { depotFile: file.depotFile, action: file.action, change, shelved: change };
      if (file.action === 'delete' || file.action === 'move/delete') {
        record = shape === 'shelved'
          ? { ...shelfIdentity, shelvedType: type }
          : { ...shelfIdentity, type };
      } else if (shape === 'shelved') {
        record = { ...shelfIdentity, shelvedDigest: digest, shelvedFileSize: fileSize, shelvedType: type };
      } else if (shape === 'both') {
        record = {
          ...shelfIdentity,
          digest: `head:${file.depotFile}`,
          fileSize: '999999',
          type: type === 'text' ? 'binary' : 'text',
          shelvedDigest: digest,
          shelvedFileSize: fileSize,
          shelvedType: type,
        };
      } else if (shape === 'missing-digest') {
        record = { ...shelfIdentity, fileSize, type };
      } else if (shape === 'missing-size') {
        record = { ...shelfIdentity, digest, type };
      } else if (shape === 'mixed') {
        record = { ...shelfIdentity, shelvedDigest: digest, fileSize, type };
      } else if (shape === 'absent') {
        record = {
          ...shelfIdentity,
          shelved: '',
          type,
          clientFile: `//${selectedClient ?? 'unknown'}/${path.basename(file.depotFile)}`,
          desc: 'fake shelf',
          isMapped: '1',
          revtime: '1',
          workRev: file.rev ?? '1',
          actionOwner: process.env.P4USER ?? state.user ?? 'agent',
        };
      } else if (shape === 'head-only') {
        record = { depotFile: file.depotFile, action: file.action, change, digest, fileSize, type };
      } else {
        record = { ...shelfIdentity, digest, fileSize, type };
      }
      process.stdout.write(tagged(record));
      if (shape === 'duplicate') process.stdout.write(tagged(record));
    }
    return;
  }

  if (command === 'print') {
    takeFlag(args, '-q');
    if (Number.isSafeInteger(state.printDelayMs) && state.printDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, state.printDelayMs));
    }
    const match = /^(\/\/.*)@=(\d+)$/.exec(args[0] ?? '');
    if (!match) return fail('print requires an exact shelved file spec');
    const [, depotFile, change] = match;
    const file = state.shelves[change]?.find((entry) => entry.depotFile === depotFile);
    if (!file || file.action === 'delete' || file.action === 'move/delete') return fail('exact shelved file content is unavailable');
    const content = file.contentBase64 === undefined
      ? Buffer.from(`${file.depotFile}:${file.action}`)
      : Buffer.from(file.contentBase64, 'base64');
    process.stdout.write(content);
    if (state.printExitMarker) {
      await fs.writeFile(state.printExitMarker, 'exiting\n');
      process.exit(23);
    }
    return;
  }

  if (command === 'reshelve') {
    const promoted = takeFlag(args, '-p');
    const source = takeOption(args, '-s');
    const destination = takeOption(args, '-c');
    if (!state.shelves[source]) return fail(`Change ${source} has no shelved files.`);
    const destinationForm = state.changes[destination];
    if (!destinationForm || destinationForm.Client !== selectedClient || destinationForm.Status !== 'pending') {
      return fail(`Change ${destination} is not a pending change for client ${selectedClient}.`);
    }
    if (state.shelves[destination]) return fail(`Change ${destination} already has shelved files.`);
    state.shelves[destination] = structuredClone(state.shelves[source]);
    state.reshelves ??= [];
    state.reshelves.push({ source, destination, client: selectedClient, promoted });
    if (fault?.times > 0 && fault.afterCreate) {
      fault.times -= 1;
      fail(fault.error ?? 'connection dropped after reshelve');
      return;
    }
    process.stdout.write(tagged({ change: destination, action: 'reshelved', promoted: promoted ? '1' : '0' }));
    return;
  }

  if (command === 'unshelve') {
    const shelf = takeOption(args, '-s');
    const change = takeOption(args, '-c');
    const files = state.shelves[shelf];
    if (!files) return fail(`Change ${shelf} has no shelved files.`);
    const conflict = files.find((file) => state.opened.some((entry) => entry.client === selectedClient && entry.depotFile === file.depotFile));
    if (conflict) return fail(`${conflict.depotFile} - can't unshelve (already opened on this client).`);
    for (const file of files) {
      state.opened.push({ client: selectedClient, depotFile: file.depotFile, action: file.action, change });
      process.stdout.write(tagged({ depotFile: file.depotFile, change, action: file.action }));
    }
    return;
  }

  if (command === 'shelve') {
    const replacing = takeFlag(args, '-r');
    if (args[0] === '-d') {
      const change = takeOption(args, '-c');
      if (!state.shelves[change]) return fail(`Change ${change} has no shelved files.`);
      delete state.shelves[change];
      if (fault?.times > 0 && fault.afterMutation) {
        fault.times -= 1;
        fail(fault.error ?? 'connection dropped after shelf deletion');
        return;
      }
      process.stdout.write(tagged({ change, action: 'deleted' }));
      return;
    }
    const change = takeOption(args, '-c');
    if (replacing && !state.shelves[change]) return fail(`Change ${change} has no shelved files.`);
    if (!replacing && state.shelves[change]) return fail(`Change ${change} already has shelved files.`);
    const files = state.opened.filter((entry) => entry.client === selectedClient && String(entry.change) === change)
      .map(({ depotFile, action }) => ({ depotFile, action, rev: state.have[selectedClient]?.[depotFile] ?? '1', type: 'text' }));
    if (files.length === 0) return fail('No files to shelve.');
    state.shelves[change] = files;
    process.stdout.write(tagged({ change, action: replacing ? 'replaced' : 'shelved' }));
    return;
  }

  if (command === 'revert') {
    if (args[0] !== '-k') return fail('fake only permits metadata-only revert -k');
    args.shift();
    const change = takeOption(args, '-c');
    if (args.length !== 1 || args[0] !== `//${selectedClient}/...`) return fail('revert must use the exact client syntax');
    state.opened = state.opened.filter((entry) => !(entry.client === selectedClient && String(entry.change) === change));
    process.stdout.write(tagged({ change, action: 'reverted' }));
    return;
  }

  fail(`unsupported fake p4 command '${command ?? ''}'`);
});
