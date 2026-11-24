'use strict';
// Outreach autopilot for the Jarrett Adams portal.
// Picks the next eligible podcast or book-influencer target, drafts a pitch
// with Claude, holds it briefly so a person can cancel, then sends it through
// the n8n Gmail webhook and logs it. No person approves each send, so the
// rules in eligibility() are the safety net. Change them with care.

const fs = require('fs');
const path = require('path');

const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i;
const TAKEN = ['working', 'submitted', 'confirmed', 'passed'];

function strip(html) { return String(html || '').replace(/<[^>]+>/g, '').replace(/\\\//g, '/').replace(/\s+/g, ' ').trim(); }
function norm(s) { return strip(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
function names(title) { return strip(title).split(/\s+\/\s+|\s*\(|\)|,| with /).map(norm).filter(n => n.length >= 5); }

// Pull window.PORTAL out of index.html. The block is plain JSON.
function loadPortal(indexHtml) {
  const html = String(indexHtml);
  const a = html.indexOf('window.PORTAL = ');
  if (a < 0) throw new Error('window.PORTAL not found');
  const start = a + 'window.PORTAL = '.length;
  const end = html.indexOf('\n};', start);
  return JSON.parse(html.slice(start, end + 2));
}

// Every podcast and influencer entry, with the tier facts the rules need.
function catalogue(P) {
  const out = [];
  const gated = (P.pipeline || []).some(x => x.state === 'gate');
  (P.podcasts || []).forEach((tier, i) => (tier.items || []).forEach(it => out.push({
    id: it.id, title: strip(it.title), kind: 'podcast', tier: tier.name,
    body: strip(it.body), angle: strip(it.hook), viaPublicist: i === 0 || /massive/i.test(tier.name)
  })));
  (P.influencers || []).forEach(tier => (tier.items || []).forEach(it => out.push({
    id: it.id, title: strip(it.title), kind: 'influencer', tier: tier.name,
    body: strip(it.body), angle: strip(it.ask), handle: strip(it.handle), reach: strip(it.reach),
    kidsGate: gated && /kids/i.test(tier.name)
  })));
  return out;
}

function coveredRule(P, title) {
  const mine = names(title);
  let found = null;
  ((P.covered || {}).groups || []).forEach(g => (g.items || []).forEach(c => {
    if (!c.rule) return;
    const theirs = names(c.title);
    const hit = mine.some(m => theirs.some(t => m === t || m.includes(t) || t.includes(m)));
    if (hit && (!found || /don't/i.test(c.rule))) found = { rule: c.rule, title: strip(c.title) };
  }));
  return found;
}

function createOutreach(opts) {
  const file = path.join(opts.dataDir, 'outreach.json');
  const P = opts.portal;
  const targets = catalogue(P);
  const env = opts.env || process.env;
  const cfg = {
    mode: ['dry', 'live'].includes(env.OUTREACH_MODE) ? env.OUTREACH_MODE : 'off',
    dailyCap: Math.max(1, Math.min(20, Number(env.OUTREACH_DAILY_CAP) || 5)),
    holdMin: Math.max(0, env.OUTREACH_HOLD_MINUTES === undefined ? 30 : Number(env.OUTREACH_HOLD_MINUTES) || 0),
    gapMin: Math.max(1, Number(env.OUTREACH_GAP_MINUTES) || 20),
    tz: env.OUTREACH_TZ || 'America/New_York',
    signature: (env.OUTREACH_SIGNATURE || 'Ali\nOsai Creative, for Jarrett Adams').replace(/\\n/g, '\n'),
    canDraft: !!opts.draft || !!env.ANTHROPIC_API_KEY,
    canSend: !!opts.deliver || !!(env.OUTREACH_WEBHOOK_URL && env.OUTREACH_WEBHOOK_SECRET)
  };
  const now = opts.now || (() => new Date());

  let db = { contacts: {}, messages: [], paused: false, seq: 0 };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { /* first run */ }
  // A send that was cut off mid-flight may or may not have gone out. Never resend it.
  db.messages.forEach(m => { if (m.status === 'sending') { m.status = 'unknown'; m.error = 'Server restarted during the send. Check the Sent folder before retrying.'; } });

  function save() {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file);
  }

  const msgsFor = id => db.messages.filter(m => m.targetId === id);
  const live = m => ['queued', 'sending', 'sent', 'unknown', 'dry'].includes(m.status);

  // Why a target can't be contacted right now, or null if it can.
  function eligibility(t) {
    const c = db.contacts[t.id] || {};
    if (t.viaPublicist) return { code: 'publicist', why: 'Goes through PRH and Convergent publicity, not a direct email.' };
    if (t.kidsGate) return { code: 'gate', why: "Waits for Jarrett's written sign-off on the kids' series." };
    const cov = coveredRule(P, t.title);
    if (cov && /don't/i.test(cov.rule)) return { code: 'covered', why: 'Already covered him (' + cov.title + "). Don't pitch." };
    if (cov && !c.peg) return { code: 'peg', why: 'Covered him before (' + cov.title + '). Add a real news peg to pitch a new angle.' };
    if (/^hold\b/i.test(t.angle) && !c.peg) return { code: 'peg', why: 'On hold until there is a news peg. Add one to release it.' };
    if (TAKEN.includes(opts.getStatus(t.id))) return { code: 'taken', why: 'Already marked ' + opts.getStatus(t.id) + ' in the portal.' };
    const mine = msgsFor(t.id);
    if (mine.some(m => m.status === 'sent')) return { code: 'sent', why: 'Already emailed.' };
    if (mine.some(m => m.status === 'unknown')) return { code: 'check', why: 'A send was interrupted. Check the Sent folder, then mark it.' };
    if (c.hold) return { code: 'held', why: 'Held by ' + (c.holdBy || 'the team') + '. Release it to put it back in line.' };
    if (mine.filter(m => m.status === 'failed').length >= 2) return { code: 'failed', why: 'Two sends failed. Check the address.' };
    if (!c.email) return { code: 'contact', why: 'Needs a contact email.' };
    if (db.messages.some(m => m.to === c.email.toLowerCase() && live(m) && m.targetId !== t.id)) return { code: 'dupe', why: 'That address has already been emailed for another entry.' };
    return null;
  }

  // ---- time: weekdays 9:00 to 16:00 in the configured zone
  function local(d) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, weekday: 'short', hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const g = k => parts.find(p => p.type === k).value;
    return { day: g('year') + '-' + g('month') + '-' + g('day'), weekday: g('weekday'), hour: Number(g('hour')) % 24 };
  }
  function inWindow(d) { const l = local(d); return !['Sat', 'Sun'].includes(l.weekday) && l.hour >= 9 && l.hour < 16; }
  function sentToday(d) { const day = local(d).day; return db.messages.filter(m => ['sent', 'dry'].includes(m.status) && m.sentAt && local(new Date(m.sentAt)).day === day).length; }
  function lastSend() { return db.messages.reduce((a, m) => (m.sentAt && m.sentAt > a ? m.sentAt : a), ''); }

  // ---- drafting
  async function claudeDraft(t, contact) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    const system = [
      'You write one short pitch email on behalf of attorney and author Jarrett Adams. It is sent automatically, with no human edit, so it must be safe to send exactly as written.',
      'Rules:',
      '- Use only facts from the fact sheet and the target notes. Never invent an episode, a quote, a statistic, a date, a mutual contact, or praise for a specific piece of their work that the notes do not name.',
      '- 90 to 150 words in the body. Plain, warm, specific. Sentence case. No em dashes, no exclamation marks, no bullet lists, no bracketed placeholders, no links other than ones in the fact sheet.',
      '- Open with why this show or reader fits, then the one ask from the notes, then an easy next step (reply to this email). For book reviewers, offer to mail a physical copy; never mention attachments.',
      '- Write as the sender in the first person. Do not sign off; the signature is added for you.',
      '- If the notes are too thin to write an honest, specific pitch, reply with the single word SKIP.',
      'Reply in this exact shape: first line "Subject: ..." (under 70 characters), a blank line, then the body starting with the greeting.'
    ].join('\n');
    const user = [
      'Fact sheet about Jarrett and the sender:', opts.profile || '(none provided)', '',
      'Target: ' + t.title + ' (' + (t.kind === 'podcast' ? 'podcast or show' : 'book reviewer or community') + ', group: ' + t.tier + ')',
      'Why they fit: ' + t.body,
      (t.kind === 'podcast' ? 'Angle to lead with: ' : 'The ask: ') + t.angle,
      t.reach ? 'Reach: ' + t.reach : '',
      contact.name ? 'Greet: ' + contact.name : 'No contact name known. Greet the team by the show or publication name.',
      contact.peg ? 'News peg to build on (written by the team, treat as fact): ' + contact.peg : ''
    ].filter(Boolean).join('\n');
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      messages: [{ role: 'user', content: user }]
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined to draft this one.');
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }

  // Turn the model's reply into {subject, body}, or throw with the reason it isn't safe to send.
  function vet(raw) {
    const text = String(raw || '').replace(/\r/g, '').trim();
    if (/^SKIP\b/.test(text)) throw new Error('Not enough in the notes to write an honest pitch.');
    const m = /^Subject:\s*(.+)\n+([\s\S]+)$/.exec(text);
    if (!m) throw new Error('Draft came back in the wrong shape.');
    const subject = m[1].trim(), body = m[2].trim();
    const words = body.split(/\s+/).length;
    if (subject.length > 90 || words < 50 || words > 220) throw new Error('Draft was the wrong length (' + words + ' words).');
    if (/[—–]/.test(subject + body)) throw new Error('Draft used a dash the house style forbids.');
    if (/\[[^\]]*\]|\{\{|TODO|lorem/i.test(subject + body)) throw new Error('Draft still had a placeholder in it.');
    return { subject, body: body + '\n\n' + cfg.signature };
  }

  async function webhookDeliver(msg) {
    const res = await fetch(env.OUTREACH_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Outreach-Secret': env.OUTREACH_WEBHOOK_SECRET },
      body: JSON.stringify({ to: msg.to, subject: msg.subject, text: msg.body, ref: msg.id }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('Mail webhook answered ' + res.status);
  }
  const draft = opts.draft || claudeDraft;
  const deliver = opts.deliver || webhookDeliver;

  function hold(id, by, why) {
    db.contacts[id] = Object.assign({}, db.contacts[id], { hold: true, holdBy: by, holdWhy: why });
  }

  // ---- one pass of the autopilot. Safe to call as often as you like.
  let busy = false;
  async function tick() {
    if (busy || cfg.mode === 'off' || db.paused) return 'idle';
    busy = true;
    try {
      const d = now();
      if (!inWindow(d)) return 'outside hours';
      if (sentToday(d) >= cfg.dailyCap) return 'cap reached';

      // 1. send whatever is due
      const due = db.messages.find(m => m.status === 'queued');
      if (due) {
        if (new Date(due.sendAt) > d) return 'holding';
        const last = lastSend();
        if (last && d - new Date(last) < cfg.gapMin * 60e3) return 'spacing';
        const t = targets.find(x => x.id === due.targetId);
        const block = t && eligibilityIgnoringQueue(t);
        if (!t || block) { due.status = 'cancelled'; due.error = block ? block.why : 'Entry no longer in the portal.'; save(); return 'cancelled'; }
        if (cfg.mode === 'dry') { due.status = 'dry'; due.sentAt = d.toISOString(); hold(t.id, 'Autopilot (test mode)', 'Drafted in test mode. Release to send for real.'); save(); return 'dry'; }
        if (!cfg.canSend) return 'no mail webhook';
        due.status = 'sending'; save();
        try {
          await deliver(due);
          due.status = 'sent'; due.sentAt = now().toISOString(); save();
          opts.setStatus(t.id, 'submitted', t.title);
          return 'sent';
        } catch (e) {
          due.status = 'failed'; due.error = String(e.message || e).slice(0, 200); save();
          return 'failed';
        }
      }

      // 2. otherwise draft the next one in line
      if (!cfg.canDraft) return 'no drafting key';
      const next = targets.find(t => !eligibility(t) && !msgsFor(t.id).some(m => m.status === 'queued'));
      if (!next) return 'nothing eligible';
      const c = db.contacts[next.id];
      try {
        const v = vet(await draft(next, c));
        db.messages.unshift({
          id: 'm' + (++db.seq), targetId: next.id, title: next.title, to: c.email.toLowerCase(),
          subject: v.subject, body: v.body, status: 'queued',
          createdAt: d.toISOString(), sendAt: new Date(d.getTime() + cfg.holdMin * 60e3).toISOString()
        });
        if (db.messages.length > 500) db.messages.length = 500;
        save();
        return 'drafted';
      } catch (e) {
        hold(next.id, 'Autopilot', String(e.message || e).slice(0, 200)); save();
        return 'held';
      }
    } finally { busy = false; }
  }
  // Same checks as eligibility(), minus "needs a contact" noise for something already queued.
  function eligibilityIgnoringQueue(t) { return eligibility(t); }

  // ---- what the page shows
  function view() {
    const d = now();
    return {
      mode: cfg.mode, paused: db.paused, dailyCap: cfg.dailyCap, holdMin: cfg.holdMin, sentToday: sentToday(d),
      inWindow: inWindow(d), tz: cfg.tz, canDraft: cfg.canDraft, canSend: cfg.canSend,
      targets: targets.map(t => {
        const c = db.contacts[t.id] || {};
        return { id: t.id, title: t.title, kind: t.kind, tier: t.tier, angle: t.angle, email: c.email || '', name: c.name || '', peg: c.peg || '', holdWhy: c.hold ? c.holdWhy || '' : '', block: eligibility(t) };
      }),
      messages: db.messages.slice(0, 60)
    };
  }

  // ---- changes made by signed-in people
  function setContact(id, body, user) {
    if (!targets.some(t => t.id === id)) return 'unknown entry';
    const email = String(body.email || '').trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) return 'That email address does not look right.';
    const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
    const prev = db.contacts[id] || {};
    db.contacts[id] = Object.assign({}, prev, { email, name: clean(body.name, 80), peg: clean(body.peg, 400), by: user.name, at: now().toISOString() });
    if (body.hold === true) hold(id, user.name, 'Held by ' + user.name + '.');
    if (body.hold === false) { delete db.contacts[id].hold; delete db.contacts[id].holdBy; delete db.contacts[id].holdWhy; }
    save();
    return null;
  }
  function cancel(msgId, user) {
    const m = db.messages.find(x => x.id === msgId && x.status === 'queued');
    if (!m) return 'That message has already gone or was cancelled.';
    m.status = 'cancelled'; m.error = 'Cancelled by ' + user.name + '.';
    hold(m.targetId, user.name, 'Draft cancelled by ' + user.name + '.');
    save();
    return null;
  }
  function setPaused(v) { db.paused = !!v; save(); }

  return { tick, view, setContact, cancel, setPaused, eligibility, targets, vet, cfg };
}

module.exports = { createOutreach, loadPortal, catalogue, coveredRule };
