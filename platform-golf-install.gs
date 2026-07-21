// ═══════════════════════════════════════════════════════════════
//  Platform Golf — Installation Report Handler v4.7.0
//  Google Apps Script — deploy as Web App (Execute as: Me, Anyone)
//
//  v3.0.0 — Reassign modal, Approve, Flag, folder suggestions
//  v3.1.0 — /misc slash command (text notes → Drive)
//  v3.2.0 — Message shortcut: Save to Misc Folder (images → Drive)
//  v3.3.0 — /info command (private overview)
//  v3.4.0 — /onboarding command (public channel overview), form URL in CONFIG
//  v3.5.0 — Slash commands moved to separate script (platform-golf-slash-commands.gs)
//  v3.6.0 — HEIC → JPG auto-conversion using Slack's pre-generated thumbnails
//  v3.7.0 — Image description saved as Description.txt alongside misc files
//  v3.8.0 — ⏳ pending message on misc file submit; fixed HEIC via slackGetFile GET request
//  v3.9.0 — All misc text + image descriptions appended to single Miscellaneous Notes.txt
//  v4.0.0 — Legacy Installation Log form (platform-golf-legacy-install.html) + GAS handler
//  v4.1.0 — ⏳ pending message on Approve button click
//  v4.2.0 — ⏳ pending message on /misc text submit
//  v4.3.0 — New photo fields: PC back, motherboard, enclosure, screen/projector, projector mount, surrounding turf
//  v4.4.0 — Video upload support: preserve MIME type and use correct file extension (.mp4, .mov, etc.)
//  v4.5.0 — Legacy form: show photo/video counts separately in Slack notification
//  v4.6.0 — Error reporting: client-side errors and GAS exceptions DM your@email.com
//  v4.7.0 — Misc notes live at Installation Report / Miscellaneous Notes.txt (not inside Miscellaneous/)
// ═══════════════════════════════════════════════════════════════

const CONFIG = {
  // Main Google Drive folder that holds all customer project folders
  DRIVE_PARENT_FOLDER_ID: 'YOUR_DRIVE_PARENT_FOLDER_ID',

  // Holding folder name — created automatically inside the parent if it doesn't exist
  PENDING_FOLDER_NAME: 'Pending Review',

  // Subfolder created inside the matched customer folder when filing
  INSTALL_SUBFOLDER_NAME: 'Installation Report',

  SLACK_BOT_TOKEN:    'xoxb-YOUR-SLACK-BOT-TOKEN',
  SLACK_CHANNEL:      '#your-slack-channel',
  SLACK_ERROR_EMAIL:  'your@email.com',  // receives DM on any GAS error or client-side failure

  FOLDER_NAME_FORMAT: 'name_location_date', // or 'name_date'
  TIMEZONE:           'America/New_York',

  // Paste the hosted form URL here when it's live — /info will link to it automatically
  FORM_URL: '',
};


// ── ENTRY POINT ──────────────────────────────────────────────────

function doPost(e) {
  try {
    if (e.parameter && e.parameter.payload) {
      return handleSlackInteraction(JSON.parse(e.parameter.payload));
    }
    if (e.parameter && e.parameter.formData) {
      const body = JSON.parse(e.parameter.formData);
      if (body.formType === 'error') return handleErrorReport(e);
      if (body.formType === 'misc')  return handleLegacyFormSubmission(e);
      return handleFormSubmission(e);
    }
    return respond(400, 'Unknown request type');
  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
    try { dmError('GAS — Unhandled doPost Error', err.message + '\n' + err.stack); } catch (_) {}
    return respond(500, err.message);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', version: '4.3.0' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── FORM SUBMISSION ───────────────────────────────────────────────

function handleFormSubmission(e) {
  const body = JSON.parse(e.parameter.formData);

  // 1. Drop files into the Pending Review holding folder
  const pendingFolder = createPendingEntry(body);

  // 2. Write a summary Google Doc so form data is always saved, even with no photos
  createSummaryDoc(body, pendingFolder);

  // 3. Upload any photos
  uploadBase64Files(body.files || {}, pendingFolder);

  // 4. Search existing customer folders for the best match
  const match = findBestMatch(body.fields || {});

  // 5. Notify Slack with the suggestion
  postInstallNotification(body, pendingFolder, match);

  return respond(200, 'OK', { pendingFolderId: pendingFolder.getId() });
}


// ── PENDING FOLDER ────────────────────────────────────────────────

function getOrCreateHoldingFolder() {
  const parent = DriveApp.getFolderById(CONFIG.DRIVE_PARENT_FOLDER_ID);
  const existing = parent.getFoldersByName(CONFIG.PENDING_FOLDER_NAME);
  return existing.hasNext() ? existing.next() : parent.createFolder(CONFIG.PENDING_FOLDER_NAME);
}

function createPendingEntry(formData) {
  const holding = getOrCreateHoldingFolder();
  const name    = buildSubmissionName(formData.fields || {});
  return holding.createFolder('⏳ ' + name);
}

function buildSubmissionName(f) {
  const customer = (f.customerName || 'Unknown Customer').trim();
  const date     = formatDate(f.dateStart || new Date().toISOString().slice(0, 10));

  if (CONFIG.FOLDER_NAME_FORMAT === 'name_location_date') {
    const loc = [f.locCity, f.locState].filter(Boolean).map(s => s.trim()).join(', ');
    return loc ? `${customer} — ${loc} — ${date}` : `${customer} — ${date}`;
  }
  return `${customer} — ${date}`;
}


// ── FILE UPLOAD ───────────────────────────────────────────────────

// Human-readable labels for every upload field in the form
const PHOTO_LABELS = {
  prelim:             'Pre-Build — Incomplete Preliminary Work',
  siteissue:          'Pre-Build — Site Issues',
  materials:          'Pre-Build — Damaged or Missing Materials',
  cbserial:           'Control Box — Serial Number',
  cbphotos:           'Control Box — Photos',
  wiring:             'Actuator — Wiring',
  frame:              'Actuator — Frame (Pre-Deck)',
  calib:              'Calibration — Photos',
  calib_measurements: 'Calibration — Written Measurements',
  finished:           'Finished Platform',
  room:               'Room — Overall View',
  obstacles:          'Room — Obstacles or Issues',
  room_extra:         'Room — Additional Photos',
  issues:             'Install Issues — Photos',
  // PC Documentation
  pc_back:            'PC — Back Panel',
  pc_motherboard:     'PC — Motherboard (Through Case)',
  // Room & Site additions
  enclosure:          'Enclosure',
  screen_projector:   'Screen with Projector On',
  projector_mount:    'Projector Mount',
  // Finished Platform additions
  turf_surround:      'Surrounding Area Turf',
  // Legacy form
  photos:             'Installation Photos',
};

/**
 * Files arrive as base64-encoded strings inside the JSON payload.
 * Images are pre-compressed to JPEG by the client.
 * Videos are sent as-is with their original MIME type preserved in fileInfo.type.
 */
function uploadBase64Files(files, folder) {
  Object.entries(files).forEach(([fieldName, fileArray]) => {
    if (!Array.isArray(fileArray)) return;
    const label = PHOTO_LABELS[fieldName] || fieldName;
    const total = fileArray.length;

    fileArray.forEach((fileInfo, idx) => {
      try {
        const mimeType  = fileInfo.type || 'image/jpeg';
        const ext       = mimeToExt(mimeType);
        const base64    = fileInfo.data.split(',')[1];
        const suffix    = total > 1 ? ` - ${idx + 1} of ${total}` : '';
        const fileName  = `${label}${suffix}${ext}`;

        const blob = Utilities.newBlob(
          Utilities.base64Decode(base64),
          mimeType,
          fileName
        );
        const uploaded = folder.createFile(blob);
        uploaded.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (err) {
        Logger.log(`File upload error (${fieldName}[${idx}]): ${err.message}`);
      }
    });
  });
}

function mimeToExt(mimeType) {
  const map = {
    'image/jpeg':      '.jpg',
    'image/png':       '.png',
    'image/gif':       '.gif',
    'image/webp':      '.webp',
    'video/mp4':       '.mp4',
    'video/quicktime': '.mov',
    'video/webm':      '.webm',
    'video/x-msvideo': '.avi',
    'video/3gpp':      '.3gp',
    'video/3gpp2':     '.3g2',
  };
  return map[mimeType] || (mimeType.startsWith('video/') ? '.mp4' : '.jpg');
}


// ── SUMMARY DOCUMENT ─────────────────────────────────────────────

function createSummaryDoc(body, folder) {
  const f   = body.fields     || {};
  const r   = body.radios     || [];
  const cb  = body.checkboxes || [];
  const sub = body.subInputs  || {};

  const radio   = name => { const x = r.find(i => i.name === name); return x ? x.value.toUpperCase() : '—'; };
  const checked = name => { const items = cb.filter(i => i.name === name).map(i => i.value); return items.length ? items.join(', ') : 'None selected'; };
  const val     = id   => (f[id] || '').trim() || '—';

  const submittedAt = body.submittedAt
    ? Utilities.formatDate(new Date(body.submittedAt), CONFIG.TIMEZONE, 'MMM d, yyyy h:mm a z')
    : '—';

  const SEP  = '────────────────────────────────────────';
  const line = (label, value) => `  ${label}: ${value}`;
  const lines = [];

  const section = title => {
    lines.push('', SEP);
    lines.push(`  ${title.toUpperCase()}`);
    lines.push(SEP);
  };

  // ── Header ──
  lines.push('════════════════════════════════════════');
  lines.push('  PLATFORM GOLF — INSTALLATION REPORT');
  lines.push('════════════════════════════════════════');
  lines.push(line('Submitted',     submittedAt));
  lines.push(line('Submission ID', body.submissionId || '—'));

  // ── Job Info ──
  section('Job Info');
  lines.push(line('Customer',             val('customerName')));
  lines.push(line('Location',             [val('locCity'), val('locState'), val('locCountry')].filter(v => v !== '—').join(', ') || '—'));
  lines.push(line('Installation Company', val('installCo')));
  lines.push(line('Installer',            val('installerName')));
  lines.push(line('Start Date',           val('dateStart')));
  lines.push(line('End Date',             val('dateEnd') !== '—' ? val('dateEnd') : 'N/A'));
  lines.push(line('Platform Type',        val('platformType')));
  if (val('projectDesc') !== '—') lines.push(line('Project Description', val('projectDesc')));

  // ── Pre-Build Checklist ──
  section('Pre-Build Checklist');
  lines.push(line('All preliminary work completed', radio('preliminary')));
  if (radio('preliminary') === 'NO' && val('prelimDesc') !== '—')
    lines.push(line('  Incomplete work', val('prelimDesc')));
  lines.push(line('Any site issues', radio('siteissues')));
  if (radio('siteissues') === 'YES' && val('siteIssueDesc') !== '—')
    lines.push(line('  Site issue details', val('siteIssueDesc')));
  lines.push(line('All materials arrived in good condition', radio('materials')));
  if (radio('materials') === 'NO' && val('materialsDesc') !== '—')
    lines.push(line('  Damaged / missing items', val('materialsDesc')));

  // ── Equipment Installed ──
  section('Equipment Installed');
  lines.push(line('Launch Monitors', checked('lm')));
  if (sub.lm_trugolf_products)   lines.push(line('  TruGolf products',      sub.lm_trugolf_products));
  if (sub.lm_trackman_model)     lines.push(line('  TrackMan model',         sub.lm_trackman_model));
  if (sub.lm_foresight_model)    lines.push(line('  Foresight model',        sub.lm_foresight_model));
  if (sub.lm_flightscope_model)  lines.push(line('  FlightScope model',      sub.lm_flightscope_model));
  if (sub.lm_other_specify)      lines.push(line('  Other LM',               sub.lm_other_specify));
  lines.push(line('Simulation Software', checked('sim')));
  if (sub.sim_other_specify)     lines.push(line('  Other software',         sub.sim_other_specify));
  lines.push(line('Putting Technology',  checked('putt')));
  if (sub.putt_other_specify)    lines.push(line('  Other putting tech',     sub.putt_other_specify));
  lines.push(line('Motion Capture',      checked('mocap')));
  if (sub.mocap_gears_system)    lines.push(line('  GEARS system',           sub.mocap_gears_system));
  if (sub.mocap_swingcat_system) lines.push(line('  Swing Catalyst system',  sub.mocap_swingcat_system));
  if (sub.mocap_other_specify)   lines.push(line('  Other motion capture',   sub.mocap_other_specify));
  if (val('displaysText')   !== '—') lines.push(line('Displays & Projectors', val('displaysText')));
  if (val('otherEquipText') !== '—') lines.push(line('Other Equipment',       val('otherEquipText')));

  // ── Platform Documentation ──
  section('Platform Documentation');
  if (val('cbSerialNum')    !== '—') lines.push(line('Control Box Serial #',    val('cbSerialNum')));
  if (val('cbNotes')        !== '—') lines.push(line('Control Box Notes',       val('cbNotes')));
  if (val('wiringNotes')    !== '—') lines.push(line('Actuator Wiring Notes',   val('wiringNotes')));
  if (val('frameNotes')     !== '—') lines.push(line('Frame Assembly Notes',    val('frameNotes')));
  if (val('calibNotes')     !== '—') lines.push(line('Calibration Notes',       val('calibNotes')));
  if (val('finishedNotes')  !== '—') lines.push(line('Finished Platform Notes', val('finishedNotes')));

  // ── Room & Site ──
  section('Room & Site');
  if (val('obstaclesDesc') !== '—') lines.push(line('Obstacles / Issues', val('obstaclesDesc')));
  else lines.push('  No obstacles or issues noted.');

  // ── Issues & Final Notes ──
  section('Issues & Final Notes');
  lines.push(line('Issues during installation', radio('issues')));
  if (radio('issues') === 'YES') {
    if (val('issuesDesc')     !== '—') lines.push(line('  Issues description', val('issuesDesc')));
    if (val('issuesResolved') !== '—') lines.push(line('  How resolved',       val('issuesResolved')));
  }
  if (val('additionalNotes') !== '—') lines.push(line('Additional Notes', val('additionalNotes')));

  lines.push('', '════════════════════════════════════════', '');

  const content  = lines.join('\n');
  const fileName = `Installation Report — ${val('customerName')} — ${val('dateStart')}.txt`;
  const file     = DriveApp.createFile(fileName, content, MimeType.PLAIN_TEXT);
  file.moveTo(folder);
}


// ── FOLDER MATCHING ───────────────────────────────────────────────

/**
 * Returns { folder, name, id, score, label } for the best matching
 * customer folder, or null if no folders exist yet.
 */
function findBestMatch(fields) {
  const customer = (fields.customerName || '').toLowerCase().trim();
  const city     = (fields.locCity      || '').toLowerCase().trim();
  const state    = (fields.locState     || '').toLowerCase().trim();

  const folders = getCustomerFolders();
  if (!folders.length) return null;

  let best = null;
  folders.forEach(f => {
    const score = scoreMatch(f.name, customer, city, state);
    if (!best || score > best.score) {
      best = { folder: f.folder, name: f.name, id: f.id, score };
    }
  });

  if (!best) return null;

  best.label = best.score >= 80 ? '✅ Strong match'
             : best.score >= 50 ? '⚠️ Possible match'
             : '❓ Low confidence';

  return best;
}

function scoreMatch(folderName, customer, city, state) {
  const fn = folderName.toLowerCase();

  // Exact customer name contained in folder name
  if (customer && fn.includes(customer)) return 90;

  // Folder name contained in customer name (short names)
  const fnWords = fn.split(/[\s\-—,]+/).filter(w => w.length > 2);
  const custWords = customer.split(/[\s\-—,]+/).filter(w => w.length > 2);
  const commonWords = fnWords.filter(w => custWords.includes(w));

  let score = custWords.length
    ? (commonWords.length / Math.max(fnWords.length, custWords.length)) * 75
    : 0;

  // Bonus for city/state match
  if (city  && fn.includes(city))  score += 10;
  if (state && fn.includes(state)) score += 5;

  return Math.round(score);
}

/**
 * Returns all subfolders of the parent EXCEPT the Pending Review holding folder.
 * Each entry: { folder, name, id }
 */
function getCustomerFolders() {
  const parent  = DriveApp.getFolderById(CONFIG.DRIVE_PARENT_FOLDER_ID);
  const folders = [];
  const iter    = parent.getFolders();
  while (iter.hasNext()) {
    const f = iter.next();
    if (f.getName() === CONFIG.PENDING_FOLDER_NAME) continue;
    folders.push({ folder: f, name: f.getName(), id: f.getId() });
  }
  return folders;
}


// ── FILE TO CUSTOMER FOLDER ────────────────────────────────────────

/**
 * Moves all files from the pending folder into
 * [customerFolder] / Installation Report / [date — location] /
 *
 * Each submission gets its own dated subfolder so previous
 * installation reports are never overwritten.
 */
function fileSubmission(pendingFolderId, customerFolderId) {
  const pendingFolder  = DriveApp.getFolderById(pendingFolderId);

  // Guard: if already filed (trashed), don't create a duplicate
  if (pendingFolder.isTrashed()) {
    Logger.log('Pending folder already filed — skipping duplicate: ' + pendingFolderId);
    return null;
  }

  const customerFolder = DriveApp.getFolderById(customerFolderId);

  // Get or create the top-level "Installation Report" folder
  const reportFolderName = CONFIG.INSTALL_SUBFOLDER_NAME;
  const reportIter       = customerFolder.getFoldersByName(reportFolderName);
  const reportFolder     = reportIter.hasNext()
    ? reportIter.next()
    : customerFolder.createFolder(reportFolderName);

  // Build a unique dated subfolder name from the pending folder
  // e.g. "2026-05-21 — Austin, TX" — strip the leading ⏳ emoji and
  // take just the date + location portions
  const pendingName  = pendingFolder.getName().replace(/^[⏳🚩]\s*/, '');
  const sessionName  = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd')
                     + ' — ' + pendingName.split(' — ').slice(1, 3).join(' — ');

  // Always create a fresh subfolder — never reuse an existing one
  const sessionFolder = reportFolder.createFolder(sessionName);

  // Move all files into the session subfolder
  const files = pendingFolder.getFiles();
  while (files.hasNext()) {
    files.next().moveTo(sessionFolder);
  }

  // Move any subfolders too
  const subFolders = pendingFolder.getFolders();
  while (subFolders.hasNext()) {
    subFolders.next().moveTo(sessionFolder);
  }

  // Trash the now-empty pending folder
  pendingFolder.setTrashed(true);

  return sessionFolder;
}


// ── SLACK: INITIAL MESSAGE ────────────────────────────────────────

function postInstallNotification(formData, pendingFolder, match) {
  const f  = formData.fields     || {};
  const r  = formData.radios     || [];
  const cb = formData.checkboxes || [];

  const radio   = name => { const x = r.find(i => i.name === name); return x ? x.value : null; };
  const checked = name => { const items = cb.filter(i => i.name === name).map(i => i.value); return items.length ? items.join(', ') : '—'; };

  const customer  = (f.customerName  || 'Unknown').trim();
  const location  = [f.locCity, f.locState, f.locCountry].filter(Boolean).join(', ') || '—';
  const company   = f.installCo      || '—';
  const installer = f.installerName  || '—';
  const platform  = f.platformType   || '—';
  const dateRange = f.dateEnd ? `${f.dateStart} → ${f.dateEnd}` : (f.dateStart || '—');
  const desc      = f.projectDesc    || '';
  const subId     = formData.submissionId || '—';
  const subAt     = formData.submittedAt
    ? new Date(formData.submittedAt).toLocaleString('en-US', { timeZone: CONFIG.TIMEZONE })
    : '—';

  const preCheckOk   = radio('preliminary') === 'yes' && radio('siteissues') === 'no' && radio('materials') === 'yes';
  const issuesDuring = radio('issues');

  // Meta embedded in button values
  const meta = JSON.stringify({
    pendingFolderId:    pendingFolder.getId(),
    matchedFolderId:    match ? match.id   : null,
    matchedFolderName:  match ? match.name : null,
    customer,
    location,
  });

  // Match suggestion block
  const matchBlock = match
    ? {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Suggested customer folder:*\n${match.label}  —  \`${match.name}\``,
        },
      }
    : {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Suggested customer folder:*\n❓ No existing folders found — use Reassign to select one` },
      };

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 New Installation Report — Pending Review', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Customer*\n${customer}` },
        { type: 'mrkdwn', text: `*Location*\n${location}` },
        { type: 'mrkdwn', text: `*Platform*\n${platform}` },
        { type: 'mrkdwn', text: `*Install Date*\n${dateRange}` },
        { type: 'mrkdwn', text: `*Company*\n${company}` },
        { type: 'mrkdwn', text: `*Installer*\n${installer}` },
      ],
    },
    ...(desc ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Project Description*\n${desc}` } }] : []),
    { type: 'divider' },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Pre-Build Check*\n${preCheckOk ? '✅ All clear' : '⚠️ Issues noted'}` },
        { type: 'mrkdwn', text: `*Issues During Install*\n${issuesDuring === 'yes' ? '⚠️ Yes' : issuesDuring === 'no' ? '✅ No' : '—'}` },
        { type: 'mrkdwn', text: `*Launch Monitors*\n${checked('lm')}` },
        { type: 'mrkdwn', text: `*Sim Software*\n${checked('sim')}` },
      ],
    },
    { type: 'divider' },
    matchBlock,
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅  Approve & File', emoji: true }, style: 'primary', action_id: 'approve',  value: meta },
        { type: 'button', text: { type: 'plain_text', text: '✏️  Reassign',       emoji: true },                   action_id: 'reassign', value: meta },
        { type: 'button', text: { type: 'plain_text', text: '🚩  Flag',           emoji: true }, style: 'danger',  action_id: 'flag',     value: meta },
      ],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '📁 View Pending Folder', emoji: true }, url: pendingFolder.getUrl(), action_id: 'open_pending' },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Submission ID: ${subId}  ·  ${subAt}` }],
    },
  ];

  slackPost('chat.postMessage', {
    channel: CONFIG.SLACK_CHANNEL,
    text:    `New install report — ${customer} (${installer})`,
    blocks,
  });
}


// ── SLACK INTERACTION HANDLER ─────────────────────────────────────

function handleSlackInteraction(payload) {
  if (payload.type === 'block_actions') {
    const action  = payload.actions[0];
    const channel = payload.channel.id;
    const ts      = payload.message.ts;
    const user    = payload.user.name;
    const meta    = JSON.parse(action.value);

    if      (action.action_id === 'approve')  approveAndFile(meta, channel, ts, user);
    else if (action.action_id === 'reassign') openReassignModal(payload.trigger_id, meta, channel, ts);
    else if (action.action_id === 'flag')     flagSubmission(meta, channel, ts, user);

    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }

  if (payload.type === 'block_suggestion') {
    return handleFolderSuggestions(payload);
  }

  if (payload.type === 'view_submission') {
    if (payload.view.callback_id === 'reassign_modal')  return handleReassignSubmit(payload);
    if (payload.view.callback_id === 'misc_modal')      return handleMiscSubmit(payload);
    if (payload.view.callback_id === 'misc_file_modal') return handleMiscFileSubmit(payload);
  }

  // Message shortcut — save Slack file(s) to a customer's Misc folder
  if (payload.type === 'message_action') {
    openMiscFileModal(payload);
    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }

  return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
}


// ── APPROVE ───────────────────────────────────────────────────────

function approveAndFile(meta, channel, ts, approvedBy) {
  if (!meta.matchedFolderId) {
    // No match was found — update message asking them to reassign first
    slackPost('chat.update', {
      channel, ts,
      text: '⚠️ No customer folder matched — please use Reassign to select one.',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `⚠️ *No customer folder was matched for this submission.*\nPlease click *Reassign* to select the correct folder.` } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '✏️  Reassign', emoji: true }, action_id: 'reassign', value: JSON.stringify(meta) },
            { type: 'button', text: { type: 'plain_text', text: '🚩  Flag',     emoji: true }, style: 'danger', action_id: 'flag', value: JSON.stringify(meta) },
          ],
        },
      ],
    });
    return;
  }

  // Show immediate ⏳ so staff know filing is in progress
  slackPost('chat.update', {
    channel, ts,
    text: `⏳ Filing — ${meta.customer}`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `⏳ *Filing in progress...*\n*${meta.customer}* → \`${meta.matchedFolderName}\`\n_Approved by @${approvedBy} — usually completes within a few seconds._` },
    }],
  });

  const installFolder = meta.isMisc
    ? fileMiscFormToFolder(meta.pendingFolderId, meta.matchedFolderId)
    : fileSubmission(meta.pendingFolderId, meta.matchedFolderId);

  const folderLabel = `${meta.matchedFolderName} / ${CONFIG.INSTALL_SUBFOLDER_NAME}`;

  slackPost('chat.update', {
    channel, ts,
    text: `✅ Filed — ${meta.customer}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Approved & filed by @${approvedBy}*\n*${meta.customer}* — ${meta.location}\n📁 Filed to: \`${folderLabel}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '📁 Open Installation Report', emoji: true }, url: installFolder.getUrl(), action_id: 'open_filed' },
        ],
      },
    ],
  });
}


// ── FLAG ──────────────────────────────────────────────────────────

function flagSubmission(meta, channel, ts, flaggedBy) {
  const pending = DriveApp.getFolderById(meta.pendingFolderId);
  pending.setName('🚩 FLAGGED — ' + pending.getName().replace(/^⏳ /, ''));

  slackPost('chat.update', {
    channel, ts,
    text: `🚩 Flagged — ${meta.customer}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🚩 *Flagged by @${flaggedBy}* — needs follow-up\n*${meta.customer}* — ${meta.location}\nStill sitting in Pending Review folder.`,
        },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: '📁 View in Drive', emoji: true }, url: pending.getUrl(), action_id: 'open_flagged' },
          { type: 'button', text: { type: 'plain_text', text: '✏️ Reassign', emoji: true }, action_id: 'reassign', value: JSON.stringify(meta) },
        ],
      },
    ],
  });
}


// ── REASSIGN MODAL ────────────────────────────────────────────────

function openReassignModal(triggerId, meta, channel, ts) {
  slackPost('views.open', {
    trigger_id: triggerId,
    view: {
      type:             'modal',
      callback_id:      'reassign_modal',
      private_metadata: JSON.stringify({ ...meta, channel, ts }),
      title:  { type: 'plain_text', text: 'File to Customer Folder' },
      submit: { type: 'plain_text', text: 'File It' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `Submission from *${meta.customer}*\nType the correct customer folder name — we'll find the closest match in Drive.` },
        },
        ...(meta.matchedFolderName ? [{
          type: 'section',
          text: { type: 'mrkdwn', text: `Current suggestion: \`${meta.matchedFolderName}\`` },
        }] : []),
        {
          type:     'input',
          block_id: 'folder_select',
          label:    { type: 'plain_text', text: 'Customer Folder' },
          hint:     { type: 'plain_text', text: 'Start typing to filter, then select the correct folder.' },
          element: {
            type:             'external_select',
            action_id:        'value',
            min_query_length: 0,
            placeholder:      { type: 'plain_text', text: 'Search customer folders…' },
          },
        },
        {
          type:     'input',
          block_id: 'note',
          optional: true,
          label:    { type: 'plain_text', text: 'Note (optional)' },
          element: {
            type:        'plain_text_input',
            action_id:   'value',
            placeholder: { type: 'plain_text', text: 'e.g. Installer used company name instead of customer' },
          },
        },
      ],
    },
  });
}

// Populates the external_select dropdown as the user types.
// Slack allows 10 seconds for this — plenty of time for a Drive folder list.
function handleFolderSuggestions(payload) {
  const query   = (payload.value || '').toLowerCase();
  const folders = getCustomerFolders();
  const options = folders
    .filter(f => !query || f.name.toLowerCase().includes(query))
    .slice(0, 100)
    .map(f => ({
      text:  { type: 'plain_text', text: f.name },
      value: JSON.stringify({ id: f.id, name: f.name }),
    }));
  return ContentService
    .createTextOutput(JSON.stringify({ options }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleReassignSubmit(payload) {
  const meta     = JSON.parse(payload.view.private_metadata);
  const values   = payload.view.state.values;
  const selected = values.folder_select.value.selected_option;
  const note     = values.note?.value?.value || '';

  if (!selected) {
    return ContentService
      .createTextOutput(JSON.stringify({
        response_action: 'errors',
        errors: { folder_select: 'Please select a customer folder.' },
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const best = JSON.parse(selected.value);

  // Immediately show a "filing in progress" status so staff know it's queued
  slackPost('chat.update', {
    channel: meta.channel,
    ts:      meta.ts,
    text:    `⏳ Filing — ${meta.customer}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏳ *Filing in progress...*\n*${meta.customer}* → \`${best.name}\`\n_Requested by @${payload.user.name} — usually completes within a minute._`,
        },
      },
    ],
  });

  const jobKey = 'reassign_' + meta.pendingFolderId;
  PropertiesService.getScriptProperties().setProperty(jobKey, JSON.stringify({
    pendingFolderId:    meta.pendingFolderId,
    customerFolderId:   best.id,
    customerFolderName: best.name,
    meta, note,
    userName: payload.user.name,
  }));
  ScriptApp.newTrigger('_runQueuedReassign').timeBased().after(1).create();

  return ContentService
    .createTextOutput(JSON.stringify({ response_action: 'clear' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// Background worker — Drive filing + Slack update with no time pressure.
// Fires ~1 minute after the modal is submitted (GAS trigger minimum).
function _runQueuedReassign() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runQueuedReassign')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();

  Object.keys(all).filter(k => k.startsWith('reassign_')).forEach(jobKey => {
    let job;
    try { job = JSON.parse(all[jobKey]); } catch (e) { props.deleteProperty(jobKey); return; }
    props.deleteProperty(jobKey);

    let installFolder;
    try {
      installFolder = job.meta.isMisc
        ? fileMiscFormToFolder(job.pendingFolderId, job.customerFolderId)
        : fileSubmission(job.pendingFolderId, job.customerFolderId);
    } catch (err) {
      installFolder = null;
      Logger.log('fileSubmission error: ' + err.message);
    }

    if (!installFolder) {
      // Restore the original message with buttons so staff can try again
      slackPost('chat.update', {
        channel: job.meta.channel,
        ts:      job.meta.ts,
        text:    `⚠️ Filing failed — ${job.meta.customer}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *Filing failed* — \`${job.customerFolderName}\` could not be filed to. The folder may have been moved or deleted.\n*${job.meta.customer}* — ${job.meta.location}`,
            },
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: '✅  Approve',  emoji: true }, style: 'primary', action_id: 'approve',  value: JSON.stringify(job.meta) },
              { type: 'button', text: { type: 'plain_text', text: '✏️  Reassign', emoji: true },                   action_id: 'reassign', value: JSON.stringify(job.meta) },
              { type: 'button', text: { type: 'plain_text', text: '🚩  Flag',     emoji: true }, style: 'danger',  action_id: 'flag',     value: JSON.stringify(job.meta) },
            ],
          },
        ],
      });
      return;
    }

    slackPost('chat.update', {
      channel: job.meta.channel,
      ts:      job.meta.ts,
      text:    `✅ Filed — ${job.meta.customer}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `✅ *Filed by @${job.userName}*`,
              `*${job.meta.customer}* → \`${job.customerFolderName} / ${CONFIG.INSTALL_SUBFOLDER_NAME}\``,
              job.note ? `_Note: ${job.note}_` : null,
            ].filter(Boolean).join('\n'),
          },
        },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '📁 Open Installation Report', emoji: true }, url: installFolder.getUrl(), action_id: 'open_reassigned' },
          ],
        },
      ],
    });
  });
}


// ── SLACK API ─────────────────────────────────────────────────────

function slackPost(method, payload) {
  const res = UrlFetchApp.fetch(`https://slack.com/api/${method}`, {
    method:             'post',
    contentType:        'application/json; charset=utf-8',
    headers:            { Authorization: 'Bearer ' + CONFIG.SLACK_BOT_TOKEN },
    payload:            JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const result = JSON.parse(res.getContentText());
  if (!result.ok) Logger.log(`Slack ${method} error: ${result.error}`);
  return result;
}

// GET request for files.info — required because files.info doesn't accept JSON POST
function slackGetFile(fileId) {
  const res = UrlFetchApp.fetch(
    `https://slack.com/api/files.info?file=${encodeURIComponent(fileId)}`,
    {
      method:             'get',
      headers:            { Authorization: 'Bearer ' + CONFIG.SLACK_BOT_TOKEN },
      muteHttpExceptions: true,
    }
  );
  const result = JSON.parse(res.getContentText());
  if (!result.ok) Logger.log('Slack files.info error: ' + result.error);
  return result;
}


// ── ERROR REPORTING ───────────────────────────────────────────────

/**
 * Receives error reports posted from the HTML forms (formType: 'error').
 * Parses the context and DMs the configured error recipient.
 */
function handleErrorReport(e) {
  const body = JSON.parse(e.parameter.formData);
  const lines = [
    `*Type:* ${body.errorType || 'Unknown'}`,
    `*Form:* ${body.formLabel || '—'}`,
    body.customerName ? `*Customer:* ${body.customerName}` : null,
    `*Message:* ${body.message  || '—'}`,
    `*URL:* ${body.url          || '—'}`,
    `*Time:* ${body.timestamp   || '—'}`,
  ].filter(Boolean).join('\n');
  dmError('Form Error — ' + (body.errorType || 'Unknown'), lines);
  return respond(200, 'OK');
}

/**
 * Sends a DM to CONFIG.SLACK_ERROR_EMAIL when anything goes wrong.
 * Requires bot scopes: users:read.email, im:write, chat:write
 */
function dmError(title, details) {
  try {
    const userRes = UrlFetchApp.fetch(
      'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(CONFIG.SLACK_ERROR_EMAIL),
      { headers: { Authorization: 'Bearer ' + CONFIG.SLACK_BOT_TOKEN }, muteHttpExceptions: true }
    );
    const userJson = JSON.parse(userRes.getContentText());
    if (!userJson.ok) { Logger.log('dmError: user lookup failed — ' + userJson.error); return; }

    const dmRes = slackPost('conversations.open', { users: userJson.user.id });
    if (!dmRes.ok) { Logger.log('dmError: conversations.open failed — ' + dmRes.error); return; }

    slackPost('chat.postMessage', {
      channel: dmRes.channel.id,
      text:    '🚨 ' + title,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `🚨 *${title}*\n${String(details).slice(0, 2800)}` },
        },
      ],
    });
  } catch (e) {
    Logger.log('dmError itself failed: ' + e.message);
  }
}


// ── UTIL ──────────────────────────────────────────────────────────

function formatDate(dateStr) {
  try {
    return Utilities.formatDate(new Date(dateStr + 'T12:00:00'), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  } catch (_) { return dateStr || 'Unknown Date'; }
}

// Run once from Apps Script editor to authorize the ScriptApp trigger scope.
function authorizeScopes() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('ScriptApp authorized. Active triggers: ' + triggers.length);
}

function respond(code, message, extra) {
  return ContentService
    .createTextOutput(JSON.stringify({ code, message, ...extra }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════
//  MISC FOLDER FEATURE
//  /misc slash command  → save a text note to Drive
//  Message shortcut     → save image(s) from Slack to Drive
//
//  Text notes land in: [Customer] / Installation Report / Miscellaneous Notes.txt
//  Photos/files land in: [Customer] / Installation Report / Miscellaneous/
//  Both folders/files are created automatically if they don't exist.
// ═══════════════════════════════════════════════════════════════


// ── /misc MODAL (text notes & measurements) ───────────────────────
// Opened by the slash commands script. Submission handled here
// because modal submissions always return to the Interactivity URL.

function openMiscModal(triggerId, channelId, userName) {
  slackPost('views.open', {
    trigger_id: triggerId,
    view: {
      type:             'modal',
      callback_id:      'misc_modal',
      private_metadata: JSON.stringify({ channel: channelId, userName }),
      title:  { type: 'plain_text', text: 'Save to Misc Folder' },
      submit: { type: 'plain_text', text: 'Save' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Saves a text note or pasted content to *Miscellaneous Notes.txt* inside the customer\'s Installation Report folder. Great for measurements, room notes, or anything informal.' },
        },
        {
          type:     'input',
          block_id: 'folder_select',
          label:    { type: 'plain_text', text: 'Customer Folder' },
          hint:     { type: 'plain_text', text: 'Start typing to search.' },
          element: {
            type:             'external_select',
            action_id:        'value',
            min_query_length: 0,
            placeholder:      { type: 'plain_text', text: 'Search customer folders…' },
          },
        },
        {
          type:     'input',
          block_id: 'file_title',
          optional: true,
          label:    { type: 'plain_text', text: 'Title' },
          element: {
            type:        'plain_text_input',
            action_id:   'value',
            placeholder: { type: 'plain_text', text: 'e.g. Platform Measurements, Room Notes' },
          },
        },
        {
          type:     'input',
          block_id: 'text_content',
          label:    { type: 'plain_text', text: 'Content' },
          element: {
            type:        'plain_text_input',
            action_id:   'value',
            multiline:   true,
            placeholder: { type: 'plain_text', text: 'Paste measurements, notes, or any text here…' },
          },
        },
      ],
    },
  });
}

function handleMiscSubmit(payload) {
  const meta     = JSON.parse(payload.view.private_metadata);
  const values   = payload.view.state.values;
  const selected = values.folder_select.value.selected_option;
  const title    = values.file_title?.value?.value || '';
  const content  = values.text_content.value.value || '';

  if (!selected) {
    return ContentService.createTextOutput(JSON.stringify({
      response_action: 'errors',
      errors: { folder_select: 'Please select a customer folder.' },
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const folder = JSON.parse(selected.value);

  // Post an immediate ⏳ so the channel knows something is in progress
  const pending = slackPost('chat.postMessage', {
    channel: meta.channel,
    text:    `⏳ Saving note to ${folder.name}…`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `⏳ *Saving to Drive...*\nFiling to \`${folder.name} / ${CONFIG.INSTALL_SUBFOLDER_NAME}\`\n_Submitted by @${payload.user.name} — usually completes within a minute._` },
    }],
  });

  const jobKey = 'misc_text_' + Date.now();
  PropertiesService.getScriptProperties().setProperty(jobKey, JSON.stringify({
    type:               'text',
    customerFolderId:   folder.id,
    customerFolderName: folder.name,
    title,
    content,
    userName:           payload.user.name,
    channel:            meta.channel,
    pendingTs:          pending.ts,
  }));
  ScriptApp.newTrigger('_runQueuedMisc').timeBased().after(1).create();

  return ContentService
    .createTextOutput(JSON.stringify({ response_action: 'clear' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── MESSAGE SHORTCUT MODAL (save images/files from Slack) ─────────

function openMiscFileModal(payload) {
  const files = (payload.message.files || []).map(f => ({
    id:   f.id,
    name: f.name,
    url:  f.url_private_download,
    mime: f.mimetype,
  }));

  // Guard: shortcut triggered on a message with no attachments
  if (files.length === 0) {
    slackPost('chat.postEphemeral', {
      channel: payload.channel.id,
      user:    payload.user.id,
      text:    '⚠️ That message has no file attachments. Upload an image or file first, then use this shortcut on that message.',
    });
    return;
  }

  // Store file metadata in PropertiesService — avoids private_metadata 3 KB limit
  const fileKey = 'misc_files_' + Date.now();
  PropertiesService.getScriptProperties().setProperty(fileKey, JSON.stringify(files));

  slackPost('views.open', {
    trigger_id: payload.trigger_id,
    view: {
      type:             'modal',
      callback_id:      'misc_file_modal',
      private_metadata: JSON.stringify({ channel: payload.channel.id, userName: payload.user.name, fileKey }),
      title:  { type: 'plain_text', text: 'Save Files to Misc' },
      submit: { type: 'plain_text', text: 'Save to Drive' },
      close:  { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `Saving *${files.length} file${files.length !== 1 ? 's' : ''}* to Drive:\n${files.map(f => `• \`${f.name}\``).join('\n')}` },
        },
        {
          type:     'input',
          block_id: 'folder_select',
          label:    { type: 'plain_text', text: 'Customer Folder' },
          hint:     { type: 'plain_text', text: 'Start typing to search.' },
          element: {
            type:             'external_select',
            action_id:        'value',
            min_query_length: 0,
            placeholder:      { type: 'plain_text', text: 'Search customer folders…' },
          },
        },
        {
          type:     'input',
          block_id: 'note',
          optional: true,
          label:    { type: 'plain_text', text: 'Description (optional)' },
          hint:     { type: 'plain_text', text: 'Saved as a .txt file alongside the images so anyone viewing the folder knows what they are.' },
          element: {
            type:        'plain_text_input',
            action_id:   'value',
            multiline:   true,
            placeholder: { type: 'plain_text', text: 'e.g. Platform measurements taken during pre-install. Numbers refer to actuator positions 1-6.' },
          },
        },
      ],
    },
  });
}

function handleMiscFileSubmit(payload) {
  const meta     = JSON.parse(payload.view.private_metadata);
  const values   = payload.view.state.values;
  const selected = values.folder_select.value.selected_option;
  const note     = values.note?.value?.value || '';

  if (!selected) {
    return ContentService.createTextOutput(JSON.stringify({
      response_action: 'errors',
      errors: { folder_select: 'Please select a customer folder.' },
    })).setMimeType(ContentService.MimeType.JSON);
  }

  const folder = JSON.parse(selected.value);

  // Post an immediate "saving" message so the channel knows something is happening
  const pending = slackPost('chat.postMessage', {
    channel: meta.channel,
    text:    `⏳ Saving to ${folder.name}…`,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `⏳ *Saving to Drive...*\nFiling to \`${folder.name} / ${CONFIG.INSTALL_SUBFOLDER_NAME}\`\n_Requested by @${payload.user.name} — usually completes within a minute._` },
    }],
  });

  const jobKey = 'misc_files_job_' + Date.now();
  PropertiesService.getScriptProperties().setProperty(jobKey, JSON.stringify({
    type:               'files',
    customerFolderId:   folder.id,
    customerFolderName: folder.name,
    fileKey:            meta.fileKey,
    note,
    userName:           payload.user.name,
    channel:            meta.channel,
    pendingTs:          pending.ts,
  }));
  ScriptApp.newTrigger('_runQueuedMisc').timeBased().after(1).create();

  return ContentService
    .createTextOutput(JSON.stringify({ response_action: 'clear' }))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── MISC BACKGROUND WORKER ────────────────────────────────────────

function _runQueuedMisc() {
  // Clean up this trigger first
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === '_runQueuedMisc')
    .forEach(t => ScriptApp.deleteTrigger(t));

  const props = PropertiesService.getScriptProperties();
  const all   = props.getProperties();

  const miscJobKeys = Object.keys(all).filter(k =>
    k.startsWith('misc_text_') || k.startsWith('misc_files_job_')
  );

  miscJobKeys.forEach(jobKey => {
    let job;
    try { job = JSON.parse(all[jobKey]); } catch (e) { props.deleteProperty(jobKey); return; }
    props.deleteProperty(jobKey);

    try {
      const reportFolder = getOrCreateReportFolder(job.customerFolderId);
      const miscFolder   = getOrCreateMiscFolder(job.customerFolderId);
      const timestamp    = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');

      // ── Text note ──
      if (job.type === 'text') {
        appendToMiscNotes(reportFolder, {
          userName: job.userName,
          title:    job.title,
          content:  job.content,
        });

        const method = job.pendingTs ? 'chat.update' : 'chat.postMessage';
        slackPost(method, {
          channel: job.channel,
          ...(job.pendingTs ? { ts: job.pendingTs } : {}),
          text:    `✅ Note saved — ${job.customerFolderName}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: [
                `✅ *Saved by @${job.userName}*`,
                `📝 Appended to \`Miscellaneous Notes.txt\``,
                `📁 \`${job.customerFolderName} / ${CONFIG.INSTALL_SUBFOLDER_NAME}\``,
              ].join('\n') },
            },
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: '📁 Open Installation Report', emoji: true }, url: reportFolder.getUrl(), action_id: 'open_misc' },
              ],
            },
          ],
        });
      }

      // ── Files from Slack ──
      else if (job.type === 'files') {
        const filesRaw = props.getProperty(job.fileKey);
        if (filesRaw) props.deleteProperty(job.fileKey);
        const files = filesRaw ? JSON.parse(filesRaw) : [];

        const saved  = [];
        const failed = [];

        files.forEach(f => {
          try {
            let downloadUrl = f.url;
            let fileName    = f.name;

            // HEIC → JPG: Slack pre-generates JPEG thumbnails for every image.
            // Grab the largest available thumbnail instead of the original HEIC.
            if (f.mime === 'image/heic' || f.mime === 'image/heif' || fileName.toLowerCase().endsWith('.heic')) {
              try {
                const info = slackGetFile(f.id);
                if (info.ok && info.file) {
                  const fi       = info.file;
                  const thumbUrl = fi.thumb_1024 || fi.thumb_960 || fi.thumb_800
                                 || fi.thumb_720 || fi.thumb_480 || fi.thumb_360;
                  if (thumbUrl) {
                    downloadUrl = thumbUrl;
                    fileName    = fileName.replace(/\.heic$/i, '.jpg');
                    Logger.log('HEIC → JPG via thumb: ' + thumbUrl);
                  } else {
                    Logger.log('No thumb found for HEIC file, fields: ' + Object.keys(fi).join(', '));
                  }
                }
              } catch (convErr) {
                Logger.log('HEIC thumb lookup failed, using original: ' + convErr.message);
              }
            }

            const response = UrlFetchApp.fetch(downloadUrl, {
              headers:            { Authorization: 'Bearer ' + CONFIG.SLACK_BOT_TOKEN },
              muteHttpExceptions: true,
            });
            if (response.getResponseCode() !== 200) throw new Error('HTTP ' + response.getResponseCode());
            miscFolder.createFile(response.getBlob().setName(fileName));
            saved.push(fileName);
          } catch (err) {
            Logger.log('Misc file download error (' + f.name + '): ' + err.message);
            failed.push(f.name);
          }
        });

        // Append description + file list to the shared notes file
        if (job.note || saved.length) {
          appendToMiscNotes(reportFolder, {
            userName: job.userName,
            content:  job.note || null,
            files:    saved,
          });
        }

        const lines = [
          saved.length  ? `✅ *Saved by @${job.userName}*\n` + saved.map(n => `• \`${n}\``).join('\n') + `\n📁 \`${job.customerFolderName} / ${CONFIG.INSTALL_SUBFOLDER_NAME} / Miscellaneous\`` : null,
          (job.note || saved.length) ? `📝 Appended to \`Miscellaneous Notes.txt\`  in \`${job.customerFolderName} / ${CONFIG.INSTALL_SUBFOLDER_NAME}\`` : null,
          failed.length ? `⚠️ Failed to save: ${failed.map(n => `\`${n}\``).join(', ')}` : null,
        ].filter(Boolean).join('\n');

        const method = job.pendingTs ? 'chat.update' : 'chat.postMessage';
        slackPost(method, {
          channel: job.channel,
          ...(job.pendingTs ? { ts: job.pendingTs } : {}),
          text:    `✅ ${saved.length} file(s) saved — ${job.customerFolderName}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: lines } },
            {
              type: 'actions',
              elements: [
                { type: 'button', text: { type: 'plain_text', text: '📁 Open Installation Report', emoji: true }, url: reportFolder.getUrl(), action_id: 'open_misc' },
              ],
            },
          ],
        });
      }

    } catch (err) {
      Logger.log('_runQueuedMisc error: ' + err.message);
      try {
        const method = job.pendingTs ? 'chat.update' : 'chat.postMessage';
        slackPost(method, {
          channel: job.channel,
          ...(job.pendingTs ? { ts: job.pendingTs } : {}),
          text:    `⚠️ Failed to save to Miscellaneous folder — ${err.message}`,
        });
      } catch (_) {}
    }
  });
}


// ── MISC NOTES: APPEND ───────────────────────────────────────────

/**
 * Appends a new timestamped entry to Miscellaneous Notes.txt.
 * Creates the file with a header if it doesn't exist yet.
 * reportFolder: the Installation Report folder (file lives at that level, not inside Miscellaneous/)
 * entry: { userName, title (optional), content (optional), files (optional string[]) }
 */
function appendToMiscNotes(reportFolder, entry) {
  const NOTES_FILE = 'Miscellaneous Notes.txt';
  const SEP        = '─'.repeat(40);
  const timestamp  = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'MMM d, yyyy h:mm a z');

  // Build the new entry block
  const headerLines = [
    '',
    SEP,
    '  ' + timestamp + ' — @' + entry.userName,
  ];
  if (entry.files && entry.files.length) {
    headerLines.push('  Files: ' + entry.files.join(', '));
  }
  headerLines.push(SEP);

  const bodyLines = [];
  if (entry.title)   bodyLines.push(entry.title, '');
  if (entry.content) bodyLines.push(entry.content);

  const newEntry = headerLines.join('\n') + '\n' + bodyLines.join('\n') + '\n';

  // Read existing file or create fresh header
  const existing = reportFolder.getFilesByName(NOTES_FILE);
  let currentContent;
  let existingFile = null;

  if (existing.hasNext()) {
    existingFile   = existing.next();
    currentContent = existingFile.getBlob().getDataAsString('UTF-8');
  } else {
    currentContent = [
      '════════════════════════════════════════',
      '  YOUR COMPANY — MISCELLANEOUS NOTES',
      '════════════════════════════════════════',
      '',
    ].join('\n');
  }

  const updatedContent = currentContent + newEntry;
  const blob = Utilities.newBlob(updatedContent, MimeType.PLAIN_TEXT, NOTES_FILE);

  // Replace old file then create updated one
  if (existingFile) existingFile.setTrashed(true);
  return reportFolder.createFile(blob);
}


// ── LEGACY FORM ───────────────────────────────────────────────────

function handleLegacyFormSubmission(e) {
  const body = JSON.parse(e.parameter.formData);

  const pendingFolder = createLegacyPendingEntry(body);
  createLegacySummaryDoc(body, pendingFolder);
  uploadBase64Files(body.files || {}, pendingFolder);

  const match = findBestMatch({ customerName: body.customerName });
  postLegacyNotification(body, pendingFolder, match);

  return respond(200, 'OK', { pendingFolderId: pendingFolder.getId() });
}

function createLegacyPendingEntry(body) {
  const holding  = getOrCreateHoldingFolder();
  const customer = (body.customerName || 'Unknown').trim();
  const date     = body.installDate
    ? formatDate(body.installDate)
    : formatDate(new Date().toISOString().slice(0, 10));
  return holding.createFolder('⏳ ' + customer + ' — Legacy — ' + date);
}

function createLegacySummaryDoc(body, folder) {
  const submittedAt = body.submittedAt
    ? Utilities.formatDate(new Date(body.submittedAt), CONFIG.TIMEZONE, 'MMM d, yyyy h:mm a z')
    : '—';
  const lines = [
    '════════════════════════════════════════',
    '  PLATFORM GOLF — LEGACY INSTALLATION LOG',
    '════════════════════════════════════════',
    '',
    '  Submitted:  ' + submittedAt,
    '  Sub ID:     ' + (body.submissionId || '—'),
    '',
    '  Customer:   ' + (body.customerName  || '—'),
    '  Installer:  ' + (body.installerName || '—'),
    '  Date:       ' + (body.installDate   || '—'),
    '',
    '  Description:',
    body.projectDesc ? ('  ' + body.projectDesc) : '  —',
  ];
  const blob = Utilities.newBlob(lines.join('\n'), MimeType.PLAIN_TEXT, 'Legacy Install Log.txt');
  folder.createFile(blob);
}

function postLegacyNotification(body, pendingFolder, match) {
  const customer  = (body.customerName  || 'Unknown').trim();
  const installer = (body.installerName || '—').trim();
  const date      = body.installDate || '—';
  const desc      = body.projectDesc || '';
  const subId      = body.submissionId || '—';
  const allFiles   = ((body.files || {}).photos || []);
  const videoCount = allFiles.filter(f => f.type && f.type.startsWith('video/')).length;
  const photoCount = allFiles.length - videoCount;
  const fileDesc   = [
    photoCount > 0 ? `${photoCount} photo${photoCount !== 1 ? 's' : ''}` : null,
    videoCount > 0 ? `${videoCount} video${videoCount !== 1 ? 's' : ''}` : null,
  ].filter(Boolean).join(', ') || 'None';

  const meta = JSON.stringify({
    pendingFolderId:   pendingFolder.getId(),
    matchedFolderId:   match ? match.id   : null,
    matchedFolderName: match ? match.name : null,
    customer,
    location: 'Legacy Install',
    isMisc:   true,
  });

  const matchBlock = match
    ? { type: 'section', text: { type: 'mrkdwn', text: `*Suggested customer folder:*\n${match.label}  —  \`${match.name}\`` } }
    : { type: 'section', text: { type: 'mrkdwn', text: `*Suggested customer folder:*\n❓ No match found — use Reassign to select one` } };

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '📦 Legacy Installation Log — Pending Review', emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Customer*\n${customer}` },
        { type: 'mrkdwn', text: `*Installer*\n${installer}` },
        { type: 'mrkdwn', text: `*Install Date*\n${date}` },
        { type: 'mrkdwn', text: `*Files*\n${fileDesc}` },
      ],
    },
    ...(desc ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Description*\n${desc}` } }] : []),
    { type: 'divider' },
    matchBlock,
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅  Approve & File', emoji: true }, style: 'primary', action_id: 'approve',  value: meta },
        { type: 'button', text: { type: 'plain_text', text: '✏️  Reassign',       emoji: true },                   action_id: 'reassign', value: meta },
        { type: 'button', text: { type: 'plain_text', text: '🚩  Flag',           emoji: true }, style: 'danger',  action_id: 'flag',     value: meta },
      ],
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '📁 View Pending Folder', emoji: true }, url: pendingFolder.getUrl(), action_id: 'open_pending' },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Submission ID: ${subId}  ·  Files to Installation Report / Miscellaneous on approval` }] },
  ];

  slackPost('chat.postMessage', {
    channel: CONFIG.SLACK_CHANNEL,
    text:    `Legacy install log — ${customer} (${installer})`,
    blocks,
  });
}

function fileMiscFormToFolder(pendingFolderId, customerFolderId) {
  const pendingFolder = DriveApp.getFolderById(pendingFolderId);
  if (pendingFolder.isTrashed()) {
    Logger.log('Legacy pending folder already filed — skipping: ' + pendingFolderId);
    return null;
  }

  const reportFolder = getOrCreateReportFolder(customerFolderId);
  const miscFolder   = getOrCreateMiscFolder(customerFolderId);

  // .txt files (summary docs) live at the Installation Report level;
  // all other files (photos, videos) go into the Miscellaneous subfolder.
  const files = pendingFolder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    const name = file.getName().toLowerCase();
    file.moveTo(name.endsWith('.txt') ? reportFolder : miscFolder);
  }

  const subFolders = pendingFolder.getFolders();
  while (subFolders.hasNext()) subFolders.next().moveTo(miscFolder);

  pendingFolder.setTrashed(true);
  return reportFolder;
}


// ── MISC FOLDER HELPERS ───────────────────────────────────────────

/**
 * Gets or creates: [Customer Folder] / Installation Report
 */
function getOrCreateReportFolder(customerFolderId) {
  const customerFolder = DriveApp.getFolderById(customerFolderId);
  const iter = customerFolder.getFoldersByName(CONFIG.INSTALL_SUBFOLDER_NAME);
  return iter.hasNext()
    ? iter.next()
    : customerFolder.createFolder(CONFIG.INSTALL_SUBFOLDER_NAME);
}

/**
 * Gets or creates: [Customer Folder] / Installation Report / Miscellaneous
 * (for photos and files only — text notes live one level up)
 */
function getOrCreateMiscFolder(customerFolderId) {
  const reportFolder = getOrCreateReportFolder(customerFolderId);
  const miscIter = reportFolder.getFoldersByName('Miscellaneous');
  return miscIter.hasNext()
    ? miscIter.next()
    : reportFolder.createFolder('Miscellaneous');
}
