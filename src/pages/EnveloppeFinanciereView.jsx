import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useEnveloppes } from '../hooks/useEnveloppes';
// Batch 2: jspdf is loaded on demand inside downloadPDF (dynamic
// import) instead of statically, so it is not in the first-load bundle.
import { toast } from 'sonner';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';
import { Wallet, FileDown, Plus, Trash2, Image as ImageIcon, X, Save, Loader2, AlertTriangle, Pencil, Search, Copy } from 'lucide-react';

// Proof images used to be stored as base64 inside the Firestore document.
// Firestore documents are limited to ~1 MiB, so a report with a proof for
// every purchase failed on save with only a generic error. Proofs are now
// uploaded on save and only their download URLs are stored in Firestore,
// so the document stays small no matter how many proofs are attached.
// Dual storage: Cloudinary (free, VITE_CLOUDINARY_CLOUD_NAME /
// VITE_CLOUDINARY_UPLOAD_PRESET) is tried first, then Firebase Storage
// (kept for when its Blaze billing is fixed), then the base64 fallback
// for small reports. Old base64 proofs are kept working (PDF + display)
// and are migrated to Storage the next time their report is saved.
const PROOF_FIELDS = ['cimentImg', 'argileImg', 'carburantImg', 'autresImg'];

// Material types for the "Matériau utilisé" column (copy, 2026-10-29):
// each day-row picks its material type from this select list — Argile,
// Faïence, Revsol, Pavé, etc. — because one column covers all of them.
// Free typing for anything else lives in the Autres section (autresType),
// not in this column.
const MATERIAL_TYPES = ['Argile', 'Faïence', 'Revsol', 'Pavé', 'Béton', 'Goudron', 'Lamozik', 'Carrelage', 'Autre'];
const materialLabelOf = (row) => row.argileType === 'Autre' ? (row.argileCustomType || 'Autre') : (row.argileType || 'Argile');

// Shared proof slot (copy, 2026-11-26 — Security phase): one component
// for the four proof columns of the editor table (and, in the Phone
// phase, for the mobile expense cards), so the URL allowlist and the
// Preuve / Réutiliser buttons are enforced in exactly one place.
// Unsafe URLs are never rendered as <img>: they show "Preuve invalide"
// with a delete button instead.
const imgButtonClass = "w-full bg-slate-100 hover:bg-slate-200 border border-[#CBD5E1] text-slate-600 text-[10px] py-1 rounded flex items-center justify-center gap-1 mt-1 transition";

const ProofSlot = ({ img, rowId, field, show, onUpload, onReuse, onRemove, onOpen }) => {
  if (!show) return null;
  if (img) {
    if (!isSafeProofUrl(img)) {
      return (
        <div className="border border-red-400/60 bg-red-500/10 rounded p-1 text-center">
          <span className="block text-[10px] font-bold text-red-600">Preuve invalide</span>
          <button type="button" onClick={() => onRemove(rowId, field)} className="text-[10px] text-red-600 underline">Supprimer</button>
        </div>
      );
    }
    const thumb = <img src={img} alt="Preuve" className="h-8 w-full object-cover rounded border border-[#CBD5E1]" />;
    return (
      <div className="relative group proof-thumb">
        {onOpen ? (
          <button type="button" onClick={() => onOpen(img)} className="block w-full p-0 border-0 bg-transparent cursor-pointer" aria-label="Agrandir la preuve">{thumb}</button>
        ) : thumb}
        {/* Phone phase (2026-11-26): a dedicated corner button instead of
            a hover overlay — on touch devices the overlay was forced
            permanently opaque and covered the thumbnail. */}
        <button type="button" onClick={() => onRemove(rowId, field)} className="absolute top-1 right-1 min-w-8 min-h-8 w-8 h-8 rounded-full bg-white/95 border border-slate-300 shadow flex items-center justify-center text-slate-500 hover:text-red-500" aria-label="Supprimer la preuve"><X className="w-3.5 h-3.5" /></button>
      </div>
    );
  }
  return (
    <>
      <button type="button" onClick={() => onUpload(rowId, field)} className={imgButtonClass}><ImageIcon className="w-3 h-3" />Preuve</button>
      <button type="button" onClick={() => onReuse(rowId, field)} className={imgButtonClass}><Copy className="w-3 h-3" />Réutiliser</button>
    </>
  );
};

// A material consumption exists when a quantity or a price was entered
// for it. Rows without one must not show the default "Argile" label —
// they show dashes instead (copy, 2026-10-30).
const hasMaterialUse = (row) => (parseFloat(row.argileQt) || 0) > 0 || (parseFloat(row.argilePrix) || 0) > 0;

// Display format for money (copy, 2026-10-29): 1000 -> "1000.00 DH".
// Used for every displayed price/amount; editable inputs stay plain
// numbers while typing, since a number field cannot show the " DH".
const moneyDH = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `${n.toFixed(2)} DH` : '';
};

// Look phase (2026-11-26): French-formatted money for the PDF only
// (1 250,00 DH) — the editor keeps moneyDH above (2026-10-29).
const moneyFR = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH` : '';
};

// Batch 2: createEmptyRow lives at module level (it uses only
// Date.now/Math.random, no props or state) so resetForm can be a
// stable useCallback with no missing dependencies.
// Phone & UX phase (2026-11-26): a new row defaults to today's local date, so field
// supervisors don't tap the date picker on every line.
const todayLocal = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const createEmptyRow = () => ({
  id: Date.now() + Math.random(),
  date: todayLocal(),
  cimentQt: '', cimentPrix: '', cimentImg: null,
  argileQt: '', argilePrix: '', argileImg: null,
  argileType: 'Argile', argileCustomType: '',
  carburant: '', carburantImg: null,
  autres: '', autresImg: null, autresType: ''
});

// Proof URL allowlist (copy, 2026-11-26 — Security phase): a proof URL
// stored in Firestore is untrusted input — a tampered document could
// point <img src> or the PDF generator at an SVG data URI or an
// arbitrary host (stored-XSS / tracking). Only our own Cloudinary
// folder, Firebase Storage, and inline jpeg/png/webp (or PDF) data
// URLs are rendered. Anything else shows "Preuve invalide" instead
// of loading.
const isSafeProofUrl = (url) => {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('data:image/jpeg;base64,')
    || url.startsWith('data:image/png;base64,')
    || url.startsWith('data:image/webp;base64,')
    || url.startsWith('data:application/pdf;base64,')) return true;
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  if (cloudName && url.startsWith(`https://res.cloudinary.com/${cloudName}/`)) return true;
  if (url.startsWith('https://firebasestorage.googleapis.com/')) return true;
  return false;
};

const uploadProofToCloudinary = async (dataUrl, rowId, field) => {
  // Second storage (free Cloudinary), tried FIRST so proofs save now
  // while Firebase Storage is still blocked on Blaze billing. Firebase
  // code below is kept untouched, so it works again automatically once
  // Blaze is fixed. Returns null when Cloudinary is not configured.
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) return null;
  const blob = await fetch(dataUrl).then((r) => r.blob());
  const form = new FormData();
  form.append('file', blob, `${rowId}-${field}.jpg`);
  form.append('upload_preset', preset);
  form.append('folder', 'enveloppe_preuves');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    const json = await res.json();
    if (!res.ok || !json.secure_url) {
      throw new Error(json.error?.message || 'Cloudinary upload failed');
    }
    return json.secure_url;
  } finally {
    clearTimeout(timer);
  }
};

const uploadProofImage = async (dataUrl, rowId, field, ownerUid) => {
  // Missing proof field on an old report must become null, never undefined:
  // Firestore updateDoc() rejects explicit undefined values, which made
  // editing old reports fail even without a new proof.
  if (dataUrl === undefined) return null;
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  // Security fix (copy, 2026-10-28): proof validation, applied before any
  // upload — only images and PDFs, max ~10 MB. Defence in depth only: the
  // real gate for Cloudinary must be the unsigned preset's own format/size
  // limits in the Cloudinary dashboard, because anyone can call the upload
  // API directly with the preset name from the shipped bundle.
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const approxBytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  if (!mime.startsWith('image/') && mime !== 'application/pdf') {
    throw new Error('Preuve refusée : seuls les images et PDF sont acceptés.');
  }
  if (approxBytes > 10 * 1024 * 1024) {
    throw new Error('Preuve refusée : fichier trop volumineux (limite 10 Mo).');
  }
  // Try Cloudinary first; if it is not configured or it fails, fall
  // through to Firebase Storage below (kept for when Blaze is fixed).
  try {
    const cloudinaryUrl = await uploadProofToCloudinary(dataUrl, rowId, field);
    if (cloudinaryUrl) return cloudinaryUrl;
  } catch (err) {
    console.error('Cloudinary proof upload failed, trying Firebase:', err?.message || err);
  }
  const blob = await fetch(dataUrl).then((r) => r.blob());
  // Security fix (copy, 2026-10-28, updated 2026-11-26): Firebase Storage
  // proofs are stored under the owner's uid, matching the per-user
  // Storage rules, instead of a flat shared folder any authenticated
  // user could read or delete. When the report being edited is ownerless
  // (legacy, shared by all employees), proofs go to the shared_legacy
  // folder instead, so every employee can read them — the old 'legacy'
  // folder produced a 3-segment path that matched NO rule and was
  // unreadable by everyone. A PDF proof keeps its .pdf extension
  // (a .pdf uploaded as .jpg was mislabelled).
  const ownerFolder = ownerUid || 'shared_legacy';
  const ext = mime === 'application/pdf' ? 'pdf' : 'jpg';
  const path = `enveloppe_preuves/${ownerFolder}/${Date.now()}-${Math.random().toString(36).slice(2)}/${rowId}-${field}.${ext}`;
  // Never hang forever on a slow / blocked upload: fail fast after 20s
  // so the user gets a real error instead of a stuck "Sauvegarde..." button.
  // The underlying upload error is also logged, because a timeout usually
  // means Storage is not enabled / reachable, not just a slow network.
  // This is now the ONLY Storage attempt for a proof: proofs are no longer
  // uploaded when picked (that caused a second 45s wait before save).
  const upload = (async () => {
    const snapshot = await uploadBytes(ref(storage, path), blob);
    return getDownloadURL(snapshot.ref);
  })();
  upload.catch((err) => {
    console.error('Storage proof upload failed:', err?.code || err?.message || err);
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Envoi de la preuve trop long (timeout 20s) — vérifiez la connexion et Firebase Storage")), 20000)
  );
  return Promise.race([upload, timeout]);
};

const NUMERIC_FIELDS = ['cimentQt', 'cimentPrix', 'argileQt', 'argilePrix', 'carburant', 'autres'];
const STRING_FIELDS = ['date', 'argileType', 'argileCustomType', 'autresType'];

const cleanRowForSave = (row) => {
  const cleaned = { ...row };
  Object.keys(cleaned).forEach((k) => {
    if (cleaned[k] === undefined) delete cleaned[k];
  });
  // Sanitize (copy, 2026-11-26 — Security phase): negative amounts are
  // clamped to 0 and text fields are trimmed, so a tampered or mistyped
  // row cannot store a negative expense or padded labels.
  NUMERIC_FIELDS.forEach((k) => {
    const n = parseFloat(cleaned[k]);
    if (Number.isFinite(n) && n < 0) cleaned[k] = '0';
  });
  STRING_FIELDS.forEach((k) => {
    if (typeof cleaned[k] === 'string') cleaned[k] = cleaned[k].trim();
  });
  PROOF_FIELDS.forEach((field) => {
    if (cleaned[field] === undefined) cleaned[field] = null;
  });
  return cleaned;
};

// Upload all remaining base64 proofs in parallel (not row by row) and
// report progress, so a report with a proof for every purchase does not
// sit on "Sauvegarde..." with no feedback.
// If Storage upload fails (timeout, not enabled, rules), fall back to
// keeping the base64 proofs ONLY when the whole document stays under
// ~850 KB, so a small edit still saves. Large reports still need Storage,
// and then the real Storage error is thrown.
const prepareRowsForSave = async (rowsToSave, headerForSave, onProgress, ownerUid) => {
  const jobs = [];
  rowsToSave.forEach((row, rowIndex) => {
    PROOF_FIELDS.forEach((field) => {
      if (typeof row[field] === 'string' && row[field].startsWith('data:')) {
        jobs.push({ rowIndex, field });
      }
    });
  });
  const results = rowsToSave.map((r) => cleanRowForSave(r));
  let done = 0;
  let firstError = null;
  // Shared proofs (copy, 2026-10-29): identical base64 images (one proof
  // reused for several consommations) are uploaded ONCE and share the
  // same URL, so the PDF grouping by image still works after a reload.
  const uploadCache = new Map();
  onProgress?.(0, jobs.length);
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const dataUrl = rowsToSave[job.rowIndex][job.field];
        if (!uploadCache.has(dataUrl)) {
          uploadCache.set(dataUrl, uploadProofImage(
            dataUrl,
            rowsToSave[job.rowIndex].id,
            job.field,
            ownerUid
          ));
        }
        results[job.rowIndex][job.field] = await uploadCache.get(dataUrl);
      } catch (e) {
        if (!firstError) firstError = e;
        // Keep the original base64 proof for a possible fallback below.
        results[job.rowIndex][job.field] = rowsToSave[job.rowIndex][job.field];
      }
      done += 1;
      onProgress?.(done, jobs.length);
    })
  );
  if (firstError) {
    const estimatedSize = JSON.stringify({ header: headerForSave, rows: results }).length;
    if (estimatedSize < 850000) {
      toast.error("Firebase Storage indisponible — preuve sauvegardée sans Storage (limite 1 Mo). Vérifiez Storage dans Firebase.");
      return results;
    }
    throw firstError;
  }
  return results;
};

export const EnveloppeFinanciereView = ({ user }) => {
  const { reports, loading, addReport, updateReport, deleteReport } = useEnveloppes(user);
  
  const [saving, setSaving] = useState(false);
  const [uploadingProofs] = useState(0);
  const [saveProgress, setSaveProgress] = useState('');
  const [editingId, setEditingId] = useState(null);
  // Security phase (2026-11-26): true while the report being edited is
  // ownerless (legacy). Its new proofs must go to the shared_legacy
  // Storage folder (readable by all employees), not to the editor's
  // per-user folder (which would 403 for everyone else).
  const [editingIsLegacy, setEditingIsLegacy] = useState(false);
  // Phone & UX phase (2026-11-26): unsaved-changes protection + draft
  // recovery, receipt lightbox, reuse-modal search, two-step delete.
  const [isDirty, setIsDirty] = useState(false);
  const [lightboxImg, setLightboxImg] = useState(null);
  const [reuseSearch, setReuseSearch] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const draftRestoredRef = useRef(false);
  // Draft key (per user, so shared tablets don't leak drafts between workers).
  const draftKey = user?.uid ? `hydraucan-enveloppe-draft-${user.uid}` : null;
  const [search, setSearch] = useState('');

  const [header, setHeader] = useState({ beneficiaire: '', montantAlloue: '' });
  const [rows, setRows] = useState([]);
  
  const fileInputRef = useRef(null);
  const [activeUpload, setActiveUpload] = useState({ rowId: null, field: null });
  // Shared proof (copy, 2026-10-29): { rowId, field } of the empty proof
  // slot the user wants to fill by reusing an existing proof image,
  // instead of uploading a new one. Null when the picker is closed.
  const [reuseTarget, setReuseTarget] = useState(null);

  // Batch 2 (react-hooks/exhaustive-deps): resetForm is a stable
  // callback (it only calls setState setters and the module-level
  // createEmptyRow), so the effect below can depend on it safely.
  const resetForm = useCallback(() => {
    setHeader({ beneficiaire: '', montantAlloue: '' });
    setRows([createEmptyRow()]);
    setEditingId(null);
    setEditingIsLegacy(false);
    setIsDirty(false);
  }, []);

  useEffect(() => {
    if (!editingId) resetForm();
  }, [editingId, resetForm]);

  // Phone & UX phase (2026-11-26): warn before the tab is closed or
  // refreshed with unsaved changes.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // Phone & UX phase (2026-11-26): autosave an in-progress draft to
  // localStorage (debounced) so flaky site connectivity or an accidental
  // refresh doesn't wipe entered rows. Best-effort: if the draft is too
  // big for localStorage it is simply skipped — saving still works.
  useEffect(() => {
    if (!isDirty || !draftKey) return;
    const t = setTimeout(() => {
      try {
        const raw = JSON.stringify({ header, rows, editingId, savedAt: Date.now() });
        if (raw.length < 4500000) localStorage.setItem(draftKey, raw);
      } catch { /* storage full or blocked — draft recovery is best-effort */ }
    }, 600);
    return () => clearTimeout(t);
  }, [rows, header, editingId, isDirty, draftKey]);

  // Phone & UX phase (2026-11-26): offer to restore a draft left by an
  // interrupted session (once per sign-in).
  useEffect(() => {
    if (!user || draftRestoredRef.current) return;
    draftRestoredRef.current = true;
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(`hydraucan-enveloppe-draft-${user.uid}`) || 'null'); } catch { /* ignore */ }
    if (draft && Array.isArray(draft.rows) && draft.rows.length > 0) {
      toast('Brouillon non sauvegardé trouvé', {
        description: 'Reprendre la saisie en cours ?',
        duration: 15000,
        action: {
          label: 'Restaurer',
          onClick: () => {
            setHeader(draft.header || { beneficiaire: '', montantAlloue: '' });
            setRows(draft.rows);
            setEditingId(draft.editingId || null);
            setEditingIsLegacy(false);
            setIsDirty(true);
          },
        },
      });
    }
  }, [user]);

  // Reuse-modal search resets whenever the picker opens or closes.
  useEffect(() => { setReuseSearch(''); }, [reuseTarget]);

  const handleEditClick = (report) => {
    // Phone & UX phase (2026-11-26): don't silently wipe unsaved work.
    if (isDirty && !window.confirm('Vous avez des modifications non sauvegardées. Charger ce rapport et les perdre ?')) return;
    setHeader(report.header || { beneficiaire: '', montantAlloue: '' });
    // Normalize old reports: missing proof fields become null (not
    // undefined, which Firestore rejects), missing text fields become ''.
    setRows(
      (report.rows || []).map((r) => ({
        id: r.id,
        date: r.date || '',
        cimentQt: r.cimentQt || '', cimentPrix: r.cimentPrix || '', cimentImg: r.cimentImg ?? null,
        argileQt: r.argileQt || '', argilePrix: r.argilePrix || '', argileImg: r.argileImg ?? null,
        argileType: r.argileType || 'Argile', argileCustomType: r.argileCustomType || '',
        carburant: r.carburant || '', carburantImg: r.carburantImg ?? null,
        autres: r.autres || '', autresImg: r.autresImg ?? null, autresType: r.autresType || ''
      }))
    );
    setEditingId(report.id);
    setEditingIsLegacy(!report.userId);
    setIsDirty(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Phone & UX phase (2026-11-26): "Annuler" warns first when the form
  // has unsaved changes, and drops the autosaved draft with it.
  const handleCancel = () => {
    if (isDirty && !window.confirm('Annuler les modifications non sauvegardées ?')) return;
    if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } }
    resetForm();
  };

  const handleSave = async () => {
    if (!header.beneficiaire || !header.montantAlloue) {
      return toast.error("Veuillez remplir le bénéficiaire et le montant");
    }
    if (uploadingProofs > 0) {
      return toast.error("Attendez la fin de l'envoi des preuves, puis réessayez");
    }

    setSaving(true);
    setSaveProgress('');
    try {
      // Phone & UX phase (2026-11-26): proofs whose amount was zeroed
      // are cleared on save instead of being silently uploaded and
      // printed in the PDF.
      const clearedOrphans = [];
      const rowsNoOrphans = rows.map((r) => {
        const next = { ...r };
        const pairs = [
          ['cimentImg', (parseFloat(r.cimentQt) || 0) * (parseFloat(r.cimentPrix) || 0)],
          ['argileImg', (parseFloat(r.argileQt) || 0) * (parseFloat(r.argilePrix) || 0)],
          ['carburantImg', parseFloat(r.carburant) || 0],
          ['autresImg', parseFloat(r.autres) || 0],
        ];
        pairs.forEach(([f, amt]) => { if (amt === 0 && next[f]) { next[f] = null; clearedOrphans.push(f); } });
        return next;
      });
      if (clearedOrphans.length > 0) {
        setRows(rowsNoOrphans);
        toast.info(`${clearedOrphans.length} preuve(s) sans montant retirée(s) avant la sauvegarde.`);
      }
      const headerForSave = { beneficiaire: header.beneficiaire.trim(), montantAlloue: header.montantAlloue };
      // Upload base64 proofs to Storage first, so Firestore only receives
      // small download URLs. Existing Storage URLs are kept as-is.
      // If Storage fails and the report is small, prepareRowsForSave
      // falls back to base64 instead of failing the save.
      // Security phase (2026-11-26): a legacy (ownerless) report's new
      // proofs go to the shared folder — pass null as ownerUid so
      // uploadProofImage uses 'shared_legacy' instead of the editor's uid.
      const ownerUid = editingIsLegacy ? null : user?.uid;
      const rowsToSave = await prepareRowsForSave(rowsNoOrphans, headerForSave, (done, total) => {
        setSaveProgress(total > 0 ? `${done}/${total} preuves` : '');
      }, ownerUid);
      let result;
      if (editingId) {
        result = await updateReport(editingId, { header: headerForSave, rows: rowsToSave });
      } else {
        result = await addReport({ header: headerForSave, rows: rowsToSave });
      }

      if (result.success) {
        toast.success(editingId ? "Rapport mis à jour !" : "Rapport sauvegardé !");
        if (draftKey) { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } }
        setIsDirty(false);
        resetForm();
      } else {
        const reason = result.error?.message || result.error?.code || '';
        toast.error(reason ? `Erreur de sauvegarde: ${reason}` : "Erreur de sauvegarde");
      }
    } catch (e) {
      // Show the real reason (e.g. Storage not enabled / rules) instead of
      // a generic error, so the problem can actually be fixed.
      toast.error(`Erreur de sauvegarde: ${e?.message || e?.code || e}`);
    } finally {
      setSaving(false);
      setSaveProgress('');
    }
  };

  const handleHeaderChange = (e) => { setHeader({ ...header, [e.target.name]: e.target.value }); setIsDirty(true); };
  const handleRowChange = (id, field, value) => { setRows(rows.map(r => r.id === id ? { ...r, [field]: value } : r)); setIsDirty(true); };
  // Autres typing (copy, 2026-10-29): free typing lives in the Autres
  // section (autresType field, above the Autres amount), while the
  // Matériau utilisé column uses the MATERIAL_TYPES select list above.
  // Shared proof (copy, 2026-10-29): one proof image (one invoice, one
  // receipt) can cover two or three consommations, whatever their date or
  // type. Reusing copies the image reference into another slot — no
  // re-upload, no re-photographing. Sources are the proofs already in the
  // editor rows and in the saved reports (any date, any material), each
  // shown once even if already shared. A reused URL stays a URL on save
  // (no new upload); a reused base64 proof is uploaded once on save, as
  // any new proof would be.
  const proofTypeLabel = (row, field) => field === 'cimentImg' ? 'Ciment'
    : field === 'argileImg' ? materialLabelOf(row)
    : field === 'carburantImg' ? 'Carburant' : 'Autres';
  // Phone & UX phase (2026-11-26): memoized — it used to run twice per
  // render across all saved reports and rows whenever the reuse picker
  // was open.
  const availableProofsList = useMemo(() => {
    const list = [];
    const push = (img, label) => { if (img) list.push({ img, label }); };
    rows.forEach((r) => PROOF_FIELDS.forEach((f) => {
      if (reuseTarget && r.id === reuseTarget.rowId && f === reuseTarget.field) return;
      push(r[f], `${r.date || 'Sans date'} — ${proofTypeLabel(r, f)}`);
    }));
    (reports || []).forEach((rep) => (rep.rows || []).forEach((r) => PROOF_FIELDS.forEach((f) =>
      push(r[f], `${rep.beneficiaire ? rep.beneficiaire + ' — ' : ''}${r.date || 'Sans date'} — ${proofTypeLabel(r, f)}`)
    )));
    const seen = new Set();
    return list.filter((p) => { if (seen.has(p.img)) return false; seen.add(p.img); return true; });
  }, [rows, reports, reuseTarget]);
  // Search inside the reuse picker (Phone & UX phase, 2026-11-26).
  const filteredReuseProofs = useMemo(() => {
    const q = reuseSearch.trim().toLowerCase();
    if (!q) return availableProofsList;
    return availableProofsList.filter((p) => p.label.toLowerCase().includes(q));
  }, [availableProofsList, reuseSearch]);
  const applyReusedProof = (img) => {
    if (!reuseTarget) return;
    setRows(rows.map((r) => (r.id === reuseTarget.rowId ? { ...r, [reuseTarget.field]: img } : r)));
    setReuseTarget(null);
    setIsDirty(true);
    toast.success('Preuve réutilisée');
  };
  const addRow = () => { setRows([...rows, createEmptyRow()]); setIsDirty(true); };
  // Phone & UX phase (2026-11-26): deleting a row offers an undo toast
  // instead of silently dropping the line.
  const removeRow = (id) => {
    if (rows.length === 1) return;
    const idx = rows.findIndex((r) => r.id === id);
    const removed = rows[idx];
    setRows(rows.filter((r) => r.id !== id));
    setIsDirty(true);
    toast('Ligne supprimée', {
      duration: 8000,
      action: {
        label: 'Annuler',
        onClick: () => {
          setRows((prev) => { const copy = [...prev]; copy.splice(Math.min(idx, copy.length), 0, removed); return copy; });
          setIsDirty(true);
        },
      },
    });
  };

  const triggerImageUpload = (rowId, field) => {
    setActiveUpload({ rowId, field });
    fileInputRef.current.click();
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    // Phone & UX phase (2026-11-26): capture { rowId, field } locally
    // BEFORE FileReader runs — reading activeUpload state inside the
    // async onload callback could pick up a different slot if the user
    // tapped another upload meanwhile.
    const { rowId, field } = activeUpload;
    if (!file || !rowId || !field) return;
    if (!file.type.startsWith('image/')) return toast.error("Seules les images sont acceptées ici (pas de PDF)");
    // Phone photos are often 4–10 MB: accept up to 15 MB, then compress
    // on canvas (was: rejected above 2 MB before any compression).
    if (file.size > 15 * 1024 * 1024) return toast.error("Image trop lourde (max 15 Mo)");

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Downscale to max 1200px wide (700px blurred small thermal
        // receipts in PDFs) and keep the result well under 500 KB.
        let scale = Math.min(1, 1200 / img.width);
        let quality = 0.75;
        let safeBase64 = '';
        for (let attempt = 0; attempt < 3; attempt++) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          safeBase64 = canvas.toDataURL('image/jpeg', quality);
          if (safeBase64.length * 0.75 < 500 * 1024 || attempt === 2) break;
          scale *= 0.75;
          quality = Math.max(0.45, quality - 0.15);
        }

        // Show the preview immediately and keep the proof as base64 until
        // save. Uploading here too caused a double wait when Storage is
        // down (45s on pick, then again on save). Save now makes the
        // single Storage attempt, with a 20s timeout, and falls back to
        // base64 for small reports, so picking a proof is instant.
        setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [field]: safeBase64 } : r)));
        setIsDirty(true);
        toast.success("Preuve ajoutée");
      };
      img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  // Phone & UX phase (2026-11-26): removing a proof offers an undo toast.
  const removeImage = (rowId, field) => {
    const prevImg = rows.find((r) => r.id === rowId)?.[field];
    setRows(rows.map((r) => (r.id === rowId ? { ...r, [field]: null } : r)));
    setIsDirty(true);
    if (prevImg) {
      toast('Preuve retirée', {
        duration: 8000,
        action: {
          label: 'Annuler',
          onClick: () => {
            setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, [field]: prevImg } : r)));
            setIsDirty(true);
          },
        },
      });
    }
  };

  const calculatedRows = useMemo(() => {
    return rows.map((d) => {
      const cimentTotal = (parseFloat(d.cimentQt) || 0) * (parseFloat(d.cimentPrix) || 0);
      const argileTotal = (parseFloat(d.argileQt) || 0) * (parseFloat(d.argilePrix) || 0);
      const carburant = parseFloat(d.carburant) || 0;
      const autres = parseFloat(d.autres) || 0;
      return { ...d, cimentTotal, argileTotal, totalLigne: cimentTotal + argileTotal + carburant + autres };
    });
  }, [rows]);

  const totals = useMemo(() => {
    return calculatedRows.reduce((acc, curr) => ({
      cimentTotal: acc.cimentTotal + curr.cimentTotal,
      argileTotal: acc.argileTotal + curr.argileTotal,
      carburant: acc.carburant + (parseFloat(curr.carburant) || 0),
      autres: acc.autres + (parseFloat(curr.autres) || 0),
      totalGeneral: acc.totalGeneral + curr.totalLigne,
    }), { cimentTotal: 0, argileTotal: 0, carburant: 0, autres: 0, totalGeneral: 0 });
  }, [calculatedRows]);

  const montantAlloue = parseFloat(header.montantAlloue) || 0;
  const soldeRestant = montantAlloue - totals.totalGeneral;

  const toBase64 = (url) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = url;
    });
  };

  const downloadPDF = async (reportHeader, reportRows = []) => {
    const loadingToast = toast.loading("Génération du PDF...");
    // Loaded on demand (Batch 2); if the chunk fails to load, dismiss
    // the toast and report it instead of leaving it spinning.
    let jsPDF;
    let autoTable;
    try {
      ({ jsPDF } = await import('jspdf'));
      ({ default: autoTable } = await import('jspdf-autotable'));
    } catch {
      toast.dismiss(loadingToast);
      toast.error("Impossible de charger le générateur PDF — vérifiez la connexion");
      return;
    }
    const doc = new jsPDF('landscape', 'mm', 'a4');

    const processedRows = reportRows.map(r => {
      const cimentTotal = (parseFloat(r.cimentQt) || 0) * (parseFloat(r.cimentPrix) || 0);
      const argileTotal = (parseFloat(r.argileQt) || 0) * (parseFloat(r.argilePrix) || 0);
      const carburant = parseFloat(r.carburant) || 0;
      const autres = parseFloat(r.autres) || 0;
      return { ...r, cimentTotal, argileTotal, totalLigne: cimentTotal + argileTotal + carburant + autres };
    });

    const finalTotals = processedRows.reduce((acc, curr) => ({
      cimentTotal: acc.cimentTotal + curr.cimentTotal,
      argileTotal: acc.argileTotal + curr.argileTotal,
      carburant: acc.carburant + (parseFloat(curr.carburant) || 0),
      autres: acc.autres + (parseFloat(curr.autres) || 0),
      totalGeneral: acc.totalGeneral + curr.totalLigne,
    }), { cimentTotal: 0, argileTotal: 0, carburant: 0, autres: 0, totalGeneral: 0 });

    const alloue = parseFloat(reportHeader.montantAlloue) || 0;
    const solde = alloue - finalTotals.totalGeneral;

    // --- 1. HEADER ---
    try {
      const logoData = await toBase64('/logo-hydracane.png');
      doc.addImage(logoData, 'PNG', 14, 10, 30, 12); 
    } catch { /* logo optional — continue without it */ }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(0, 0, 0);
    doc.text("SITUATION DE CONSOMMATION DE L'ENVELOPPE FINANCIÈRE", 148, 20, { align: 'center' });

    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(`Bénéficiaire : ${reportHeader.beneficiaire || '................................'}`, 14, 32);
    doc.text(`Montant de l'enveloppe allouée : ${moneyFR(alloue)}`, 14, 38);

    doc.setFont("helvetica", "italic");
    doc.setFontSize(9);
    doc.setTextColor(80, 80, 80);
    doc.text("Objet : Suivi de l'utilisation des fonds alloués par l'entreprise, détaillant les dépenses effectuées et le solde restant disponible.", 14, 45);

    // --- 2. MAIN TABLE ---
    const tableBody = processedRows.map((d, index) => [
      index + 1,
      d.date || '',
      d.cimentQt, moneyFR(d.cimentPrix), d.cimentTotal ? moneyFR(d.cimentTotal) : '',
      hasMaterialUse(d) ? materialLabelOf(d) : '———',
      d.argileQt, moneyFR(d.argilePrix), d.argileTotal ? moneyFR(d.argileTotal) : '',
      moneyFR(d.carburant),
      d.autresType ? `${d.autresType} : ${moneyFR(d.autres)}` : moneyFR(d.autres),
      d.totalLigne ? moneyFR(d.totalLigne) : ''
    ]);

    tableBody.push([
      { content: 'TOTAL', colSpan: 11, styles: { fontStyle: 'bold', halign: 'center' } },
      moneyFR(finalTotals.totalGeneral)
    ]);

    autoTable(doc, {
      head: [['N°', 'Date', 'Ciment Qt', 'Ciment P.U.', 'Ciment Total', 'Matériau utilisé', 'Mat. Qt', 'Mat. P.U.', 'Mat. Total', 'Carburant', 'Autres', 'Total']],
      body: tableBody,
      startY: 50,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2, halign: 'center', valign: 'middle', textColor: [0, 0, 0] },
      headStyles: { fillColor: [22, 41, 77], textColor: 255, fontStyle: 'bold', halign: 'center' },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 22 },
        2: { cellWidth: 16 }, 3: { cellWidth: 16 }, 4: { cellWidth: 20 },
        5: { cellWidth: 22 },
        6: { cellWidth: 16 }, 7: { cellWidth: 16 }, 8: { cellWidth: 20 },
        9: { cellWidth: 20 },
        10: { cellWidth: 20 },
        11: { cellWidth: 25 }
      }
    });

    // --- 3. RÉCAPITULATIF TABLE ---
    const finalY = doc.lastAutoTable.finalY + 15;
    
    autoTable(doc, {
      head: [['Récapitulatif', 'Montant (DH)']],
      body: [
        ['Montant alloué', moneyFR(alloue)],
        ['Total dépensé', moneyFR(finalTotals.totalGeneral)],
        ['Solde restant', moneyFR(solde)]
      ],
      startY: finalY,
      theme: 'grid',
      styles: { fontSize: 10, cellPadding: 3, textColor: [0, 0, 0] },
      headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold' },
      margin: { left: 14, right: 200 }
    });

    // --- 4. PROOF IMAGES (80x55 SIZE) ---
    const imagesToPrint = [];
    processedRows.forEach((row, index) => {
      if (row.cimentImg) imagesToPrint.push({ label: 'Ciment', amount: row.cimentTotal, img: row.cimentImg, line: index + 1 });
      if (row.argileImg) imagesToPrint.push({ label: materialLabelOf(row), amount: row.argileTotal, img: row.argileImg, line: index + 1 });
      if (row.carburantImg) imagesToPrint.push({ label: 'Carburant', amount: parseFloat(row.carburant) || 0, img: row.carburantImg, line: index + 1 });
      if (row.autresImg) imagesToPrint.push({ label: row.autresType || 'Autres', amount: parseFloat(row.autres) || 0, img: row.autresImg, line: index + 1 });
    });

    // Shared proofs (copy, 2026-10-29): consommations that share one
    // proof image (via "Réutiliser") are grouped by image, so the image
    // is printed ONCE, with the list of the consommations it covers
    // (line, type, amount) above it — never one copy per consommation.
    const mergedProofs = [];
    imagesToPrint.forEach((it) => {
      const ex = mergedProofs.find((m) => m.img === it.img);
      if (ex) ex.entries.push({ line: it.line, label: it.label, amount: it.amount });
      else mergedProofs.push({ img: it.img, entries: [{ line: it.line, label: it.label, amount: it.amount }] });
    });

    if (mergedProofs.length > 0) {
      doc.addPage();
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(0, 0, 0);
      doc.text("JUSTIFICATIFS DES DÉPENSES (PREUVES)", 148, 15, { align: 'center' });

      // 2-column grid, but rows grow to fit shared proofs' caption
      // lists (landscape A4: 297 x 210 mm, so rows must end by y = 200).
      const boxWidth = 80;
      const boxHeight = 55;
      const padding = 4;
      let rowTop = 25;
      let rowMaxHeight = 0;

      for (let idx = 0; idx < mergedProofs.length; idx++) {
        const item = mergedProofs[idx];
        const col = idx % 2;
        if (col === 0 && idx > 0) {
          rowTop += rowMaxHeight + 5;
          rowMaxHeight = 0;
        }

        const captionLines = item.entries.length === 1
          ? [`Ligne ${item.entries[0].line} - ${item.entries[0].label} : ${moneyFR(item.entries[0].amount)}`]
          : [`Preuve partagée — ${item.entries.length} consommations :`,
             ...item.entries.map((e) => `Ligne ${e.line} - ${e.label} : ${moneyFR(e.amount)}`)];
        const titleHeight = 5 * captionLines.length + 1;
        const itemHeight = titleHeight + boxHeight;
        if (rowTop + itemHeight > 200) {
          doc.addPage();
          doc.setFont("helvetica", "bold");
          doc.setFontSize(16);
          doc.setTextColor(0, 0, 0);
          doc.text("JUSTIFICATIFS DES DÉPENSES (SUITE)", 148, 15, { align: 'center' });
          rowTop = 25;
          rowMaxHeight = 0;
        }

        const x = col === 0 ? 50 : 50 + boxWidth + 37;
        const y = rowTop + titleHeight;

        captionLines.forEach((line, li) => {
          doc.setFont("helvetica", li === 0 ? "bold" : "normal");
          doc.setFontSize(li === 0 ? 10 : 9);
          doc.setTextColor(40, 40, 40);
          doc.text(line, x, rowTop + 5 * li + 4);
        });

        doc.setFillColor(248, 250, 252);
        doc.rect(x, y, boxWidth, boxHeight, 'F');

        doc.setDrawColor(200, 200, 200);
        doc.setLineWidth(0.3);
        doc.rect(x, y, boxWidth, boxHeight, 'S');

        try {
          // Storage URLs must be converted to base64 for jsPDF; old
          // base64 proofs are used directly. Security phase (2026-11-26):
          // a proof URL not on the allowlist is never fetched — it
          // prints "Erreur d'affichage" instead, like a broken image.
          let imgData = item.img;
          if (typeof imgData === 'string' && imgData.startsWith('http')) {
            if (!isSafeProofUrl(imgData)) throw new Error('Preuve invalide');
            try {
              imgData = await toBase64(imgData);
            } catch {
              // Fall through to addImage, which is caught below.
            }
          } else if (typeof imgData === 'string' && imgData.startsWith('data:')) {
            if (!isSafeProofUrl(imgData)) throw new Error('Preuve invalide');
          }
          const imgFormat = typeof imgData === 'string' && imgData.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(imgData, imgFormat, x + padding, y + padding, boxWidth - (padding * 2), boxHeight - (padding * 2));
        } catch {
          doc.setTextColor(255, 0, 0);
          doc.setFontSize(9);
          doc.text("Erreur d'affichage", x + padding + 10, y + boxHeight / 2);
        }

        rowMaxHeight = Math.max(rowMaxHeight, itemHeight);
      }
    }

    doc.save(`Enveloppe_${reportHeader.beneficiaire || 'Rapport'}.pdf`);
    toast.dismiss(loadingToast);
    toast.success("PDF généré avec succès !");
  };

  const inputClass = "w-full bg-white border border-[#CBD5E1] rounded-lg px-1 py-1 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-accent transition text-center";
  const inputHeaderClass = "w-full bg-white border border-[#CBD5E1] rounded-xl px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition";
  const labelClass = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5";
  // Phone & UX phase (2026-11-26): numeric fields take decimal input,
  // never go negative, and the mouse wheel cannot change a value while
  // scrolling past it.
  const numProps = { inputMode: 'decimal', min: '0', step: 'any', onWheel: (e) => e.currentTarget.blur() };

  // Phone & UX phase (2026-11-26): deleting a saved report is two-step —
  // the first tap arms the button ("Sûr ?"), the second really deletes.
  // (Previously a single click permanently deleted a report.)
  const handleDeleteReport = async (id) => {
    setConfirmDeleteId(null);
    await deleteReport(id);
    toast.success('Rapport supprimé');
  };

  const filteredReports = useMemo(() => {
    const sorted = [...reports].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    if (!search.trim()) return sorted;
    const q = search.toLowerCase();
    return sorted.filter((r) => {
      const headerText = `${r.header?.beneficiaire || ''} ${r.header?.montantAlloue || ''}`.toLowerCase();
      if (headerText.includes(q)) return true;
      return (r.rows || []).some((row) =>
        (row.date || '').includes(q)
        || materialLabelOf(row).toLowerCase().includes(q)
        || (row.autresType || '').toLowerCase().includes(q)
      );
    });
  }, [reports, search]);

  if (loading) return <div className="p-10 flex justify-center"><Loader2 className="w-8 h-8 text-[#0F766E] animate-spin" /></div>;

  return (
    <section className="p-2 md:p-6" dir="ltr">
      <input type="file" accept="image/*" ref={fileInputRef} onChange={handleImageChange} className="hidden" />

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-slate-900">
            {editingId ? "Modifier le Rapport" : "Nouveau Rapport"}
          </h2>
          <p className="text-sm text-slate-500 mt-1">Gérez vos dépenses et joignez les preuves.</p>
        </div>
        
        <div className="flex gap-2 w-full md:w-auto">
          <button onClick={() => downloadPDF(header, rows)} className="flex-1 md:flex-none justify-center bg-white hover:bg-slate-50 border border-[#16294D]/30 text-[#16294D] text-sm font-bold px-4 py-2 rounded-xl transition flex items-center gap-2">
            <FileDown className="w-4 h-4" />
            PDF
          </button>
          {editingId && (
            <button onClick={handleCancel} className="flex-1 md:flex-none justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold px-4 py-2 rounded-xl transition">
              Annuler
            </button>
          )}
          <button onClick={handleSave} disabled={saving || uploadingProofs > 0} className="flex-1 md:flex-none justify-center bg-[#16294D] hover:bg-[#0F1E3D] border border-[#16294D] text-white text-sm font-bold px-4 py-2 rounded-xl transition flex items-center gap-2 disabled:opacity-50">
            {(saving || uploadingProofs > 0) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? `Sauvegarde... ${saveProgress}` : uploadingProofs > 0 ? `Envoi des preuves... (${uploadingProofs})` : (editingId ? 'Mettre à jour' : 'Sauvegarder')}
          </button>
        </div>
      </div>

      <div className="bg-white border border-[#E2E8F0] shadow-sm rounded-2xl p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Bénéficiaire</label>
            <input name="beneficiaire" value={header.beneficiaire} onChange={handleHeaderChange} placeholder="Nom" className={inputHeaderClass} />
          </div>
          <div>
            <label className={labelClass}>Montant Alloué (DH)</label>
            <input name="montantAlloue" type="number" {...numProps} value={header.montantAlloue} onChange={handleHeaderChange} placeholder="0.00" className={inputHeaderClass} />
          </div>
        </div>
      </div>

      <div className="bg-white border border-[#E2E8F0] shadow-sm rounded-2xl p-2 md:p-4 mb-6 overflow-hidden">
        <div className="flex justify-end mb-2">
          <button onClick={addRow} className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold px-3 py-1.5 rounded-lg flex items-center gap-1 transition">
            <Plus className="w-3.5 h-3.5" /> Ajouter une ligne
          </button>
        </div>
        <div className="overflow-x-auto hidden lg:block">
          <table className="w-full text-xs text-slate-600 min-w-[1200px]">
            <thead>
              <tr className="bg-[#F8FAFC] text-slate-600">
                <th className="py-2 px-1 border border-[#E2E8F0] w-8" rowSpan={2}>N°</th>
                <th className="py-2 px-1 border border-[#E2E8F0] w-24" rowSpan={2}>Date</th>
                <th className="py-1 border border-[#E2E8F0]" colSpan={4}>Ciment</th>
                <th className="py-1 border border-[#E2E8F0]" colSpan={5}>Matériau utilisé</th>
                <th className="py-1 border border-[#E2E8F0]" colSpan={2}>Carburant</th>
                <th className="py-1 border border-[#E2E8F0]" colSpan={2}>Autres</th>
                <th className="py-2 px-1 border border-[#E2E8F0]" rowSpan={2}>Total</th>
                <th className="py-2 px-1 border border-[#E2E8F0]" rowSpan={2}></th>
              </tr>
              <tr className="bg-[#F8FAFC] text-[10px] text-slate-500">
                <th className="py-1 px-1 border border-[#E2E8F0]">Qt</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Prix U.</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Total</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Img</th>

                <th className="py-1 px-1 border border-[#E2E8F0]">Type</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Qt</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Prix U.</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Total</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Img</th>

                <th className="py-1 px-1 border border-[#E2E8F0]">Montant</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Img</th>

                <th className="py-1 px-1 border border-[#E2E8F0]">Montant</th>
                <th className="py-1 px-1 border border-[#E2E8F0]">Img</th>
              </tr>
            </thead>
            <tbody>
              {calculatedRows.map((d, i) => (
                <tr key={d.id} className="hover:bg-[#F8FAFC] border-b border-[#E2E8F0]">
                  <td className="text-center font-bold text-slate-500 border border-[#E2E8F0]">{i + 1}</td>
                  <td className="p-1 border border-[#E2E8F0]"><input type="date" value={d.date} onChange={(e) => handleRowChange(d.id, 'date', e.target.value)} className={inputClass} /></td>
                  
                  <td className="p-1 border border-[#E2E8F0]"><input type="number" {...numProps} value={d.cimentQt} onChange={(e) => handleRowChange(d.id, 'cimentQt', e.target.value)} className={inputClass} /></td>
                  <td className="p-1 border border-[#E2E8F0]"><input type="number" {...numProps} value={d.cimentPrix} onChange={(e) => handleRowChange(d.id, 'cimentPrix', e.target.value)} className={inputClass} /></td>
                  <td className="text-center font-mono text-[#0F766E] border border-[#E2E8F0] bg-[#F8FAFC]">{d.cimentTotal ? moneyDH(d.cimentTotal) : ''}</td>
                  <td className="border border-[#E2E8F0] p-1 align-top">
                    <ProofSlot img={d.cimentImg} rowId={d.id} field="cimentImg" show={d.cimentTotal > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                  </td>

                  <td className="p-1 border border-[#E2E8F0] align-top">
                    {hasMaterialUse(d) ? (
                      <>
                        <select value={d.argileType || 'Argile'} onChange={(e) => handleRowChange(d.id, 'argileType', e.target.value)} className={`${inputClass} !py-1.5 !text-[11px] min-w-[95px]`}>
                          {MATERIAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                        {d.argileType === 'Autre' && (
                          <input type="text" value={d.argileCustomType || ''} onChange={(e) => handleRowChange(d.id, 'argileCustomType', e.target.value)} placeholder="Préciser…" className={`${inputClass} !py-1.5 !text-[11px] mt-1`} />
                        )}
                      </>
                    ) : (
                      <span className="text-slate-500 text-[11px]">———</span>
                    )}
                  </td>
                  <td className="p-1 border border-[#E2E8F0]"><input type="number" {...numProps} value={d.argileQt} onChange={(e) => handleRowChange(d.id, 'argileQt', e.target.value)} className={inputClass} /></td>
                  <td className="p-1 border border-[#E2E8F0]"><input type="number" {...numProps} value={d.argilePrix} onChange={(e) => handleRowChange(d.id, 'argilePrix', e.target.value)} className={inputClass} /></td>
                  <td className="text-center font-mono text-[#0F766E] border border-[#E2E8F0] bg-[#F8FAFC]">{d.argileTotal ? moneyDH(d.argileTotal) : ''}</td>
                  <td className="border border-[#E2E8F0] p-1 align-top">
                    <ProofSlot img={d.argileImg} rowId={d.id} field="argileImg" show={d.argileTotal > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                  </td>

                  <td className="p-1 border border-[#E2E8F0]"><input type="number" {...numProps} value={d.carburant} onChange={(e) => handleRowChange(d.id, 'carburant', e.target.value)} className={inputClass} /></td>
                  <td className="border border-[#E2E8F0] p-1 align-top">
                    <ProofSlot img={d.carburantImg} rowId={d.id} field="carburantImg" show={d.carburant > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                  </td>

                  <td className="p-1 border border-[#E2E8F0] align-top">
                    <input type="text" value={d.autresType || ''} onChange={(e) => handleRowChange(d.id, 'autresType', e.target.value)} placeholder="Taper ce que c'est…" className={`${inputClass} !py-1.5 !text-[11px] mb-1`} />
                    <input type="number" {...numProps} value={d.autres} onChange={(e) => handleRowChange(d.id, 'autres', e.target.value)} className={inputClass} />
                  </td>
                  <td className="border border-[#E2E8F0] p-1 align-top">
                    <ProofSlot img={d.autresImg} rowId={d.id} field="autresImg" show={d.autres > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                  </td>

                  <td className="text-center font-bold text-[#0F766E] border border-[#E2E8F0] bg-[#F8FAFC]">{d.totalLigne ? moneyDH(d.totalLigne) : ''}</td>
                  <td className="text-center border border-[#E2E8F0]">
                    <button onClick={() => removeRow(d.id)} disabled={rows.length === 1} className="text-slate-500 hover:text-red-600 disabled:opacity-30 p-1"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Phone & UX phase (2026-11-26): thumb-friendly expense cards for
            phones. Inline in the same map — NOT a nested component, which
            would remount on every keystroke and lose input focus. */}
        <div className="lg:hidden space-y-3">
          {calculatedRows.map((d, i) => (
            <article key={d.id} className="bg-white border border-[#E2E8F0] rounded-2xl p-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="shrink-0 bg-[#0F766E]/10 border border-[#0F766E]/30 text-[#0F766E] text-xs font-bold rounded-full px-2.5 py-1">Ligne {i + 1}</span>
                <input type="date" value={d.date} onChange={(e) => handleRowChange(d.id, 'date', e.target.value)} className={`${inputClass} flex-1 !py-2`} />
                <span className="shrink-0 font-mono font-bold text-[#0F766E] text-sm">{d.totalLigne ? moneyDH(d.totalLigne) : '0.00 DH'}</span>
                <button onClick={() => removeRow(d.id)} disabled={rows.length === 1} className="shrink-0 text-slate-500 hover:text-red-600 disabled:opacity-30 min-w-11 min-h-11 w-11 h-11 flex items-center justify-center" aria-label="Supprimer la ligne"><Trash2 className="w-5 h-5" /></button>
              </div>

              <div className="space-y-4">
                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Ciment</h4>
                  <div className="grid grid-cols-2 gap-2">
                    <input type="number" {...numProps} value={d.cimentQt} onChange={(e) => handleRowChange(d.id, 'cimentQt', e.target.value)} placeholder="Quantité" className={`${inputClass} !py-2`} />
                    <input type="number" {...numProps} value={d.cimentPrix} onChange={(e) => handleRowChange(d.id, 'cimentPrix', e.target.value)} placeholder="Prix unitaire" className={`${inputClass} !py-2`} />
                  </div>
                  <div className="flex items-center justify-between mt-1.5">
                    <span className="text-[11px] text-slate-500">Sous-total</span>
                    <span className="font-mono text-[#0F766E] text-xs">{d.cimentTotal ? moneyDH(d.cimentTotal) : '—'}</span>
                  </div>
                  <ProofSlot img={d.cimentImg} rowId={d.id} field="cimentImg" show={d.cimentTotal > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                </div>

                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Matériau utilisé</h4>
                  {hasMaterialUse(d) ? (
                    <>
                      <select value={d.argileType || 'Argile'} onChange={(e) => handleRowChange(d.id, 'argileType', e.target.value)} className={`${inputClass} !py-2 mb-2`}>
                        {MATERIAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                      {d.argileType === 'Autre' && (
                        <input type="text" value={d.argileCustomType || ''} onChange={(e) => handleRowChange(d.id, 'argileCustomType', e.target.value)} placeholder="Préciser le matériau…" className={`${inputClass} !py-2 mb-2`} />
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <input type="number" {...numProps} value={d.argileQt} onChange={(e) => handleRowChange(d.id, 'argileQt', e.target.value)} placeholder="Quantité" className={`${inputClass} !py-2`} />
                        <input type="number" {...numProps} value={d.argilePrix} onChange={(e) => handleRowChange(d.id, 'argilePrix', e.target.value)} placeholder="Prix unitaire" className={`${inputClass} !py-2`} />
                      </div>
                      <div className="flex items-center justify-between mt-1.5">
                        <span className="text-[11px] text-slate-500">Sous-total</span>
                        <span className="font-mono text-[#0F766E] text-xs">{d.argileTotal ? moneyDH(d.argileTotal) : '—'}</span>
                      </div>
                      <ProofSlot img={d.argileImg} rowId={d.id} field="argileImg" show={d.argileTotal > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                    </>
                  ) : (
                    <p className="text-slate-500 text-xs">Aucun matériau consommé sur cette ligne.</p>
                  )}
                </div>

                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Carburant</h4>
                  <input type="number" {...numProps} value={d.carburant} onChange={(e) => handleRowChange(d.id, 'carburant', e.target.value)} placeholder="Montant (DH)" className={`${inputClass} !py-2`} />
                  <ProofSlot img={d.carburantImg} rowId={d.id} field="carburantImg" show={d.carburant > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                </div>

                <div>
                  <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">Autres</h4>
                  <input type="text" value={d.autresType || ''} onChange={(e) => handleRowChange(d.id, 'autresType', e.target.value)} placeholder="Taper ce que c'est…" className={`${inputClass} !py-2 mb-2`} />
                  <input type="number" {...numProps} value={d.autres} onChange={(e) => handleRowChange(d.id, 'autres', e.target.value)} placeholder="Montant (DH)" className={`${inputClass} !py-2`} />
                  <ProofSlot img={d.autresImg} rowId={d.id} field="autresImg" show={d.autres > 0} onUpload={triggerImageUpload} onReuse={(rowId, field) => setReuseTarget({ rowId, field })} onRemove={removeImage} onOpen={setLightboxImg} />
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>

      {reuseTarget && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-4" onClick={() => setReuseTarget(null)}>
          <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-xl max-w-lg w-full max-h-[85dvh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-slate-900 text-sm">Réutiliser une preuve existante</h3>
              <button onClick={() => setReuseTarget(null)} className="text-slate-500 hover:text-slate-900 p-1"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Une même preuve peut couvrir plusieurs consommations, quelle que soit leur date ou leur type. Choisissez une image déjà utilisée :</p>
            <input type="text" value={reuseSearch} onChange={(e) => setReuseSearch(e.target.value)} placeholder="Rechercher une preuve…" className="w-full bg-white border border-[#E2E8F0] rounded-xl px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-accent transition mb-4" />
            {filteredReuseProofs.length === 0 ? (
              <p className="text-center text-slate-500 py-8 text-sm">Aucune preuve existante pour le moment — ajoutez d'abord une preuve à une consommation.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredReuseProofs.map((p, idx) => (
                  <button key={idx} onClick={() => applyReusedProof(p.img)} className="text-left border border-[#E2E8F0] hover:border-[#0F766E] rounded-xl overflow-hidden transition group">
                    {isSafeProofUrl(p.img) ? (
                      <img src={p.img} className="h-24 w-full object-cover" />
                    ) : (
                      <span className="block h-24 w-full bg-red-500/10 text-red-600 text-[11px] font-bold flex items-center justify-center">Preuve invalide</span>
                    )}
                    <span className="block text-[11px] text-slate-600 px-2 py-1.5 group-hover:text-[#0F766E]">{p.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {lightboxImg && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setLightboxImg(null)}>
          <div className="relative max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxImg} alt="Preuve agrandie" className="w-full max-h-[85vh] object-contain rounded-2xl border border-[#E2E8F0] bg-white" />
            <button onClick={() => setLightboxImg(null)} className="absolute top-2 right-2 min-w-10 min-h-10 w-10 h-10 rounded-full bg-black/60 text-white flex items-center justify-center" aria-label="Fermer"><X className="w-5 h-5" /></button>
          </div>
        </div>
      )}

      {/* Look phase (2026-11-26): Récapitulatif as a full-width KPI strip
          with a spend progress bar (amber ≥ 90%, red over budget). */}
      <div className="bg-white border border-[#E2E8F0] rounded-2xl shadow-sm p-4 md:p-5 mb-10">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Récapitulatif</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#E2E8F0]">
          <div className="py-2 sm:py-0 sm:px-4 first:pl-0">
            <span className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Montant alloué</span>
            <span className="num-tabular font-mono font-bold text-slate-900 text-lg">{montantAlloue.toFixed(2)} DH</span>
          </div>
          <div className="py-2 sm:py-0 sm:px-4">
            <span className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Total dépensé</span>
            <span className="num-tabular font-mono font-bold text-[#0F766E] text-lg">{totals.totalGeneral.toFixed(2)} DH</span>
          </div>
          <div className="py-2 sm:py-0 sm:px-4 last:pr-0">
            <span className={`block text-[11px] font-semibold uppercase tracking-wider ${soldeRestant < 0 ? 'text-red-600' : soldeRestant === 0 ? 'text-amber-600' : 'text-slate-500'}`}>Solde restant</span>
            <span className={`num-tabular font-mono font-bold text-lg flex items-center gap-1.5 ${soldeRestant < 0 ? 'text-red-600' : soldeRestant === 0 ? 'text-amber-600' : 'text-[#0F766E]'}`}>
              {soldeRestant <= 0 && <AlertTriangle className="w-4 h-4" />}
              {soldeRestant.toFixed(2)} DH
            </span>
          </div>
        </div>
        <div className="mt-4 h-2 rounded-full bg-slate-100 overflow-hidden" role="progressbar" aria-valuenow={Math.round(Math.min(1, montantAlloue > 0 ? totals.totalGeneral / montantAlloue : 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all ${montantAlloue > 0 && totals.totalGeneral / montantAlloue > 1 ? 'bg-red-500' : montantAlloue > 0 && totals.totalGeneral / montantAlloue >= 0.9 ? 'bg-amber-500' : 'bg-[#0F766E]'}`} style={{ width: `${Math.min(100, montantAlloue > 0 ? (totals.totalGeneral / montantAlloue) * 100 : 0)}%` }} />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {montantAlloue > 0 ? `${Math.round((totals.totalGeneral / montantAlloue) * 100)} % du montant alloué dépensé` : 'Aucun montant alloué saisi'}
        </p>
      </div>

      {/* Phone & UX phase (2026-11-26): sticky bottom thumb-bar — save and
          PDF always reachable on phones without scrolling back up. */}
      <div className="lg:hidden sticky bottom-0 z-40 -mx-3 sm:-mx-4 bg-white/95 backdrop-blur border-t border-[#E2E8F0] shadow-[0_-4px_16px_rgba(15,23,42,0.08)] px-3 pt-2 pb-[env(safe-area-inset-bottom)] flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="block text-[10px] uppercase tracking-wider text-slate-500 font-bold">Solde restant</span>
          <span className={`font-mono font-bold text-sm truncate block ${soldeRestant < 0 ? 'text-red-500' : soldeRestant === 0 ? 'text-amber-600' : 'text-[#0F766E]'}`}>{soldeRestant.toFixed(2)} DH</span>
        </div>
        <button onClick={handleSave} disabled={saving || uploadingProofs > 0} className="min-h-11 px-4 bg-[#16294D] hover:bg-[#0F1E3D] border border-[#16294D] text-white text-sm font-bold rounded-xl transition disabled:opacity-50">
          {saving ? 'Sauvegarde…' : (editingId ? 'Mettre à jour' : 'Sauvegarder')}
        </button>
        <button onClick={() => downloadPDF(header, rows)} className="min-h-11 px-4 bg-white hover:bg-slate-50 border border-[#16294D]/30 text-[#16294D] text-sm font-bold rounded-xl transition flex items-center gap-1.5">
          <FileDown className="w-4 h-4" /> PDF
        </button>
      </div>
      <div className="h-20 lg:hidden" />

      <div className="bg-white backdrop-blur-md border border-[#E2E8F0] rounded-2xl p-5 md:p-6 shadow-lg max-w-5xl">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#0F766E]/10 border border-[#0F766E]/20 flex items-center justify-center">
              <Wallet className="w-4 h-4 text-[#0F766E]" />
            </div>
            <h3 className="text-xs font-bold text-slate-600 uppercase tracking-wider">
              Rapports Sauvegardés ({filteredReports.length})
            </h3>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher..." className="w-full sm:w-64 bg-white border border-[#E2E8F0] rounded-xl pl-9 pr-4 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-accent transition" />
          </div>
        </div>

        {filteredReports.length === 0 ? (
          <p className="text-center text-slate-500 py-10 text-sm">Aucun rapport sauvegardé</p>
        ) : (
          <>
          {/* Phone & UX phase (2026-11-26): saved reports as cards on phones. */}
          <div className="md:hidden space-y-3">
            {filteredReports.map((r) => {
              const totDepense = r.rows.reduce((sum, row) => {
                const ciment = (parseFloat(row.cimentQt) || 0) * (parseFloat(row.cimentPrix) || 0);
                const argile = (parseFloat(row.argileQt) || 0) * (parseFloat(row.argilePrix) || 0);
                return sum + ciment + argile + (parseFloat(row.carburant) || 0) + (parseFloat(row.autres) || 0);
              }, 0);
              const alloue = parseFloat(r.header.montantAlloue) || 0;
              const solde = alloue - totDepense;
              return (
                <article key={r.id} className={`bg-white border rounded-2xl shadow-sm p-3 ${editingId === r.id ? 'border-accent ring-1 ring-accent/50' : 'border-[#E2E8F0]'}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="font-bold text-slate-900 text-sm truncate">{r.header.beneficiaire || 'Sans nom'}</span>
                    <span className={`shrink-0 font-mono font-bold text-xs px-2 py-1 rounded-lg ${solde < 0 ? 'bg-red-500/15 text-red-600' : 'bg-[#0F766E]/10 text-[#0F766E]'}`}>Solde {moneyDH(solde)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500 mb-3">
                    <span>Alloué <span className="font-mono text-slate-600">{moneyDH(alloue)}</span></span>
                    <span>Dépensé <span className="font-mono text-[#0F766E]">{moneyDH(totDepense)}</span></span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => downloadPDF(r.header, r.rows)} className="flex-1 min-h-11 bg-white hover:bg-slate-50 border border-[#16294D]/30 text-[#16294D] text-sm font-bold rounded-xl flex items-center justify-center gap-1.5"><FileDown className="w-4 h-4" /> PDF</button>
                    <button onClick={() => handleEditClick(r)} className="flex-1 min-h-11 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-bold rounded-xl flex items-center justify-center gap-1.5"><Pencil className="w-4 h-4" /> Modifier</button>
                    <button onClick={() => confirmDeleteId === r.id ? handleDeleteReport(r.id) : setConfirmDeleteId(r.id)} className={`flex-1 min-h-11 text-sm font-bold rounded-xl flex items-center justify-center gap-1.5 ${confirmDeleteId === r.id ? 'bg-red-500 text-white' : 'bg-red-500/15 border border-red-500/40 text-red-600'}`}>{confirmDeleteId === r.id ? 'Sûr ?' : (<><Trash2 className="w-4 h-4" /> Supprimer</>)}</button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="overflow-x-auto hidden md:block">
            <table className="w-full min-w-[720px] text-xs text-slate-600">
              <thead>
                <tr className="border-b border-[#E2E8F0] text-slate-500 uppercase tracking-wider text-[10px]">
                  <th className="text-left py-2 px-2">Bénéficiaire</th>
                  <th className="text-center py-2 px-2">Montant Alloué</th>
                  <th className="text-center py-2 px-2">Dépensé</th>
                  <th className="text-center py-2 px-2">Solde</th>
                  <th className="text-center py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredReports.map((r) => {
                  const totDepense = r.rows.reduce((sum, row) => {
                    const ciment = (parseFloat(row.cimentQt) || 0) * (parseFloat(row.cimentPrix) || 0);
                    const argile = (parseFloat(row.argileQt) || 0) * (parseFloat(row.argilePrix) || 0);
                    const carb = parseFloat(row.carburant) || 0;
                    const aut = parseFloat(row.autres) || 0;
                    return sum + ciment + argile + carb + aut;
                  }, 0);
                  const alloue = parseFloat(r.header.montantAlloue) || 0;
                  const solde = alloue - totDepense;

                  return (
                    <tr key={r.id} className={`border-b border-[#E2E8F0] hover:bg-[#F8FAFC] ${editingId === r.id ? 'bg-accent/10' : ''}`}>
                      <td className="py-2 px-2">{r.header.beneficiaire || 'Sans nom'}</td>
                      <td className="text-center py-2 px-2 font-mono text-slate-600">{moneyDH(alloue)}</td>
                      <td className="text-center py-2 px-2 font-mono text-[#0F766E]">{moneyDH(totDepense)}</td>
                      <td className={`text-center py-2 px-2 font-mono font-bold ${solde < 0 ? 'text-red-600' : 'text-[#0F766E]'}`}>{moneyDH(solde)}</td>
                      <td className="text-center py-2 px-2">
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => downloadPDF(r.header, r.rows)} className="text-[#0F766E] hover:text-[#0B5E57] hover:bg-[#0F766E]/10 rounded-lg p-1.5 transition" title="Télécharger PDF">
                            <FileDown className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleEditClick(r)} className="text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg p-1.5 transition" title="Modifier">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => confirmDeleteId === r.id ? handleDeleteReport(r.id) : setConfirmDeleteId(r.id)} className={confirmDeleteId === r.id ? "bg-red-500 text-white text-[11px] font-bold rounded-lg px-2 py-1.5 transition" : "text-red-600 hover:text-red-500 hover:bg-red-500/10 rounded-lg p-1.5 transition"} title="Supprimer">
                            {confirmDeleteId === r.id ? 'Sûr ?' : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </section>
  );
};