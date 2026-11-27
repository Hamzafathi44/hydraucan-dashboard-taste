import { useState, useMemo, useRef } from 'react';
import { generateReportPDF } from '../pdfGenerator';
import { useRefections } from '../hooks/useRefections';
import TopoMapPicker from '../components/TopoMapPicker';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import {
  Wrench, FileDown, Save, Trash2, Loader2, Search, Plus, X, MapPin, Pencil, Calendar, Camera, Check, Clock, ArrowLeft
} from 'lucide-react';
import { toast } from 'sonner';

// Natures for Réfection (copy, 2026-11-27): Béton was removed on
// Michael's request — it is no longer offered for new measurements or
// remaining lines. Entries already stored with Béton keep their value
// and still display it; when such an entry is edited, Béton is added
// back as an extra option for that line only, so the value is not lost.
const NATURES = [
  'argile', 'Pavé', 'Goudron', 'Faience', 'Revsol'
];

const REMAINING_UNITS = ['m²', 'm'];

// Photo proof per measurement (copy, 2026-11-27): same upload route as
// Enveloppe proofs — Cloudinary first (VITE_CLOUDINARY_CLOUD_NAME /
// VITE_CLOUDINARY_UPLOAD_PRESET, folder enveloppe_preuves), then
// Firebase Storage (per-user path, kept for when Blaze is fixed).
// Only the download URL is stored on the measurement (photoUrl); the
// picked image is uploaded on save, never stored as base64 in Firestore.
const uploadProofToCloudinary = async (dataUrl, fileName) => {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;
  if (!cloudName || !preset) return null;
  const blob = await fetch(dataUrl).then((r) => r.blob());
  const form = new FormData();
  form.append('file', blob, fileName);
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

const uploadMeasurementPhoto = async (dataUrl, fileName, ownerUid) => {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return dataUrl;
  }
  // Same validation as Enveloppe proofs: images only, max ~10 MB.
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const approxBytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);
  if (!mime.startsWith('image/')) {
    throw new Error('Preuve refusée : seules les images sont acceptées.');
  }
  if (approxBytes > 10 * 1024 * 1024) {
    throw new Error('Preuve refusée : fichier trop volumineux (limite 10 Mo).');
  }
  // Try Cloudinary first; if it is not configured or it fails, fall
  // through to Firebase Storage below (kept for when Blaze is fixed).
  try {
    const cloudinaryUrl = await uploadProofToCloudinary(dataUrl, fileName);
    if (cloudinaryUrl) return cloudinaryUrl;
  } catch (err) {
    console.error('Cloudinary proof upload failed, trying Firebase:', err?.message || err);
  }
  const storage = getStorage();
  const blob = await fetch(dataUrl).then((r) => r.blob());
  // Same per-user path as Enveloppe proofs, matching the Storage rules
  // (only enveloppe_preuves/<uid>/... is writable).
  const ownerFolder = ownerUid || 'legacy';
  const path = `enveloppe_preuves/${ownerFolder}/${Date.now()}-${Math.random().toString(36).slice(2)}/${fileName}`;
  const upload = (async () => {
    const snapshot = await uploadBytes(ref(storage, path), blob);
    return getDownloadURL(snapshot.ref);
  })();
  upload.catch((err) => {
    console.error('Storage proof upload failed:', err?.code || err?.message || err);
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Envoi de la preuve trop long (timeout 20s)")), 20000)
  );
  return Promise.race([upload, timeout]);
};

export const RefectionView = ({ user }) => {
  const { refections, loading, addRefection, updateRefection, deleteRefection } = useRefections(user);

  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [mapPoints, setMapPoints] = useState([]);
  const [editingId, setEditingId] = useState(null);

  // Choice screen (copy, 2026-11-27): entering Réfection shows just two
  // options — Terminées / Non terminées — each with its count. Selecting
  // one opens that mode's list + form. null = choice screen. The mode is
  // local state only and resets every time the view is entered.
  const [mode, setMode] = useState(null);
  const completeCount = refections.filter((r) => r.incomplete !== true).length;
  const incompleteCount = refections.filter((r) => r.incomplete === true).length;

  // ✅ NEW: State for the Month Filter
  const [selectedMonth, setSelectedMonth] = useState('');
  // Single-day filter + download (copy, 2026-10-29): a day and a month
  // are mutually exclusive — picking one clears the other.
  const [selectedDay, setSelectedDay] = useState('');

  const [formData, setFormData] = useState({
    date: '',
    reference: '',
    type: 'Refection',
    address: '',
    incomplete: false
  });

  const [measurements, setMeasurements] = useState([
    { l: '', L: '', nature: '', photoUrl: null, photoData: null }
  ]);

  // "Reste à faire" lines, shown in Non completed mode only: { nature,
  // qty, unit, photoUrl } — nature from NATURES (no Béton), unit m² or
  // m. Each line has its own photo proof (photoData holds the picked
  // image until it is uploaded on save).
  const [remaining, setRemaining] = useState([
    { nature: '', qty: '', unit: 'm²', photoUrl: null, photoData: null }
  ]);

  // Hidden file inputs for the per-reste-line photo proof, one per row.
  const restePhotoInputs = useRef({});

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleMeasurementChange = (index, field, value) => {
    const updated = [...measurements];
    updated[index][field] = value;
    setMeasurements(updated);
  };

  const addMeasurement = () => {
    setMeasurements([...measurements, { l: '', L: '', nature: '', photoUrl: null, photoData: null }]);
  };

  const removeMeasurement = (index) => {
    if (measurements.length === 1) return;
    setMeasurements(measurements.filter((_, i) => i !== index));
  };

  const handleRemainingChange = (index, field, value) => {
    const updated = [...remaining];
    updated[index][field] = value;
    setRemaining(updated);
  };

  const addRemaining = () => {
    setRemaining([...remaining, { nature: '', qty: '', unit: 'm²', photoUrl: null, photoData: null }]);
  };

  const removeRemaining = (index) => {
    if (remaining.length === 1) return;
    setRemaining(remaining.filter((_, i) => i !== index));
  };

  const handleRemainingPhotoPicked = (index, file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Choisissez une image');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Photo trop lourde (limite 10 Mo)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      setRemaining((prev) =>
        prev.map((r, i) => (i === index ? { ...r, photoData: dataUrl } : r))
      );
    };
    reader.readAsDataURL(file);
  };

  const removeRemainingPhoto = (index) => {
    setRemaining((prev) =>
      prev.map((r, i) => (i === index ? { ...r, photoUrl: null, photoData: null } : r))
    );
  };

  const resetForm = (forMode) => {
    // The form's "incomplete" follows the selected mode (there is no
    // checkbox any more). forMode lets the mode-select handler pass the
    // mode being entered, since setMode has not applied yet.
    const m = forMode !== undefined ? forMode : mode;
    setFormData({ date: '', reference: '', type: 'Refection', address: '', incomplete: m === 'incomplete' });
    setMeasurements([{ l: '', L: '', nature: '', photoUrl: null, photoData: null }]);
    setRemaining([{ nature: '', qty: '', unit: 'm²', photoUrl: null, photoData: null }]);
    setMapPoints([]);
    setEditingId(null);
  };

  const selectMode = (m) => {
    resetForm(m);
    setSelectedMonth('');
    setSelectedDay('');
    setSearch('');
    setMode(m);
  };

  const backToChoice = () => {
    resetForm(null);
    setSelectedMonth('');
    setSelectedDay('');
    setSearch('');
    setMode(null);
  };

  const handleEditClick = (entry) => {
    setFormData({
      date: entry.date || '',
      reference: entry.reference || '',
      type: entry.type || 'Refection',
      address: entry.address || '',
      incomplete: entry.incomplete === true
    });

    setMeasurements(
      entry.measurements && entry.measurements.length > 0
        ? entry.measurements.map((m) => ({ l: m.l || '', L: m.L || '', nature: m.nature || '', photoUrl: m.photoUrl || null, photoData: null }))
        : [{ l: entry.l || '', L: entry.L || '', nature: entry.nature || '', photoUrl: null, photoData: null }]
    );

    setRemaining(
      entry.remaining && entry.remaining.length > 0
        ? entry.remaining.map((r) => ({ nature: r.nature || '', qty: r.qty ?? '', unit: r.unit || 'm²', photoUrl: r.photoUrl || null, photoData: null }))
        : [{ nature: '', qty: '', unit: 'm²', photoUrl: null, photoData: null }]
    );

    setMapPoints(entry.points || []);
    setEditingId(entry.id);

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleSave = async () => {
    if (!formData.date || !formData.reference) {
      toast.error('Please fill in the date and reference');
      return;
    }

    // The entry's status follows the selected mode for new entries, and
    // the entry's current status when editing (there is no checkbox any
    // more, so editing never flips it silently).
    const entryIncomplete = editingId ? !!formData.incomplete : mode === 'incomplete';

    // One form fills one kind only (copy, 2026-11-27): Complete mode
    // has measurements and no "Reste à faire"; Non completed mode has
    // "Reste à faire" and no measurements — an incomplete entry is
    // saved with measurements: [].
    const cleanMeasurements = entryIncomplete
      ? []
      : measurements.filter(
          (m) => m.l !== '' && m.L !== '' && m.nature !== ''
        );

    if (!entryIncomplete && cleanMeasurements.length === 0) {
      toast.error('Add at least one measurement (l, L, nature)');
      return;
    }

    const cleanRemainingRaw = entryIncomplete
      ? remaining.filter((r) => r.nature && String(r.qty).trim() !== '')
      : [];

    if (entryIncomplete && cleanRemainingRaw.length === 0) {
      toast.error('Ajoutez au moins une ligne de reste à faire');
      return;
    }

    // Photos on the "Reste à faire" lines are uploaded on save only
    // (same Cloudinary-first route as the measurement proofs). A failed
    // upload never blocks the save: the line is saved without the new
    // photo and an error toast is shown. The previously stored photo
    // (if any) is kept when an upload fails.
    setSaving(true);
    const savedRemaining = await Promise.all(
      cleanRemainingRaw.map(async (r, idx) => {
        let photoUrl = r.photoUrl || null;
        if (r.photoData) {
          try {
            photoUrl = await uploadMeasurementPhoto(
              r.photoData,
              `refection-reste-${Date.now()}-${idx}.jpg`,
              user?.uid
            );
          } catch (err) {
            console.error('Photo upload failed:', err?.message || err);
            toast.error('Échec de l’envoi de la photo — la ligne est enregistrée sans photo');
          }
        }
        return { nature: r.nature, qty: String(r.qty).trim(), unit: r.unit || 'm²', photoUrl };
      })
    );

    // Measurements keep their stored photoUrl (the form no longer has a
    // photo button for them), so already-stored photos survive an edit.
    const savedMeasurements = cleanMeasurements.map((m) => ({
      l: m.l, L: m.L, nature: m.nature, photoUrl: m.photoUrl || null
    }));

    let result;

    if (editingId) {
      result = await updateRefection(editingId, {
        ...formData,
        measurements: savedMeasurements,
        points: mapPoints,
        incomplete: entryIncomplete,
        remaining: savedRemaining
      });
    } else {
      result = await addRefection({
        ...formData,
        measurements: savedMeasurements,
        points: mapPoints,
        incomplete: entryIncomplete,
        remaining: savedRemaining
      });
    }

    setSaving(false);

    if (result.success) {
      toast.success(editingId ? 'Entry updated' : 'Entry saved');
      resetForm();
    } else {
      toast.error(editingId ? 'Failed to update' : 'Failed to save');
    }
  };

  const handleDelete = async (id) => {
    if (editingId === id) resetForm();
    if (!window.confirm('Delete this entry?')) return;
    const result = await deleteRefection(id);
    if (result.success) toast.success('Deleted');
    else toast.error('Failed to delete');
  };

  // Move an entry between the two lists: "Terminer" in the Non
  // terminées list, "Rouvrir" in the Terminées list. Only the flag
  // changes — the entry keeps its id, owner and content.
  const handleToggleStatus = async (entry, toIncomplete) => {
    if (editingId === entry.id) resetForm();
    const result = await updateRefection(entry.id, { incomplete: toIncomplete });
    if (result.success) {
      toast.success(toIncomplete ? 'Entrée rouverte (non terminée)' : 'Entrée marquée terminée');
    } else {
      toast.error('Échec de la mise à jour');
    }
  };

  const handleSingleDownload = (entry) => {
    const month = entry.date ? entry.date.slice(0, 7) : 'Tous';
    // Distinct title + filename for one entry, instead of the monthly
    // title that made the single download indistinguishable from the
    // whole-month PDF.
    generateReportPDF([entry], month, `Réfection - ${entry.reference || 'sans référence'} - ${entry.date || ''}`);
  };

  const handleGeneratePDF = () => {
    if (filtered.length === 0) {
      toast.error('No entries to export');
      return;
    }
    // ✅ Format the month for the PDF title (e.g., "2026-10" -> "Octobre 2026")
    let titleMonth = 'Tous';
    if (selectedMonth) {
      const dateObj = new Date(selectedMonth + "-01");
      titleMonth = dateObj.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    } else if (filtered[0]?.date) {
      const dateObj = new Date(filtered[0].date);
      titleMonth = dateObj.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    }
    generateReportPDF(filtered, titleMonth);
  };

  const handleDayPDF = () => {
    if (!selectedDay) {
      toast.error('Choisissez un jour d’abord');
      return;
    }
    if (filtered.length === 0) {
      toast.error('Aucune entrée pour ce jour');
      return;
    }
    // Day title in French, e.g. "29 octobre 2026"; the month arg is
    // unused when a custom title is given.
    const dayLabel = new Date(selectedDay + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    generateReportPDF(filtered, selectedDay, `Réfection - ${dayLabel}`);
  };

  // ✅ Filter by Search AND by Month / Day (day wins, month cleared)
  // Batch 2: the manual useMemo was removed — the compiler could not
  // preserve it (react-hooks/preserve-manual-memoization) and the
  // list is small, so it is computed inline and the compiler
  // memoizes it automatically. Same filter logic, no behaviour change.
  const byDate = refections.filter((r) => {
    // Split lists: each mode shows only its own entries (the choice
    // screen renders no list, so the null mode never matters here).
    if (mode && (mode === 'incomplete' ? r.incomplete !== true : r.incomplete === true)) return false;
    if (selectedDay) return (r.date || '') === selectedDay;
    if (selectedMonth) return (r.date || '').startsWith(selectedMonth);
    return true;
  });
  const searchQuery = search.trim() ? search.toLowerCase() : null;
  const filtered = searchQuery === null ? byDate : byDate.filter((r) => {
    const measurementsText = (r.measurements || [])
      .map((m) => `${m.l} ${m.L} ${m.nature || ''}`)
      .join(' ');
    const pointsText = (r.points || [])
      .map((p) => `${p.label} ${p.x} ${p.y}`)
      .join(' ');
    const remainingText = (r.remaining || [])
      .map((rem) => `${rem.nature || ''} ${rem.qty || ''} ${rem.unit || ''}`)
      .join(' ');
    return (
      (r.date || '').toLowerCase().includes(searchQuery) ||
      (r.reference || '').toLowerCase().includes(searchQuery) ||
      (r.type || '').toLowerCase().includes(searchQuery) ||
      (r.address || '').toLowerCase().includes(searchQuery) ||
      measurementsText.toLowerCase().includes(searchQuery) ||
      pointsText.toLowerCase().includes(searchQuery) ||
      remainingText.toLowerCase().includes(searchQuery)
    );
  });

  const groupedFiltered = useMemo(() => {
    if (!filtered) return [];

    const processed = filtered.map(r => {
      const mList = r.measurements && r.measurements.length > 0
          ? r.measurements
          : [{ l: r.l || '', L: r.L || '', nature: r.terrainNature || r.nature || '' }];
      const pts = r.points && r.points.length > 0 ? r.points : [null];
      return { ...r, mList, pts, totalRows: Math.max(mList.length, pts.length) };
    });

    // Group consecutive entries sharing a date; each entry keeps its
    // date's total row span and a first-of-date flag. Written as a
    // pure reduce/flatMap (no index loops or push) so the memoization
    // can be preserved by the compiler.
    const groups = processed.reduce((acc, entry) => {
      const last = acc[acc.length - 1];
      if (last && last.date === entry.date) {
        return [...acc.slice(0, -1), { ...last, dateSpan: last.dateSpan + entry.totalRows, entries: [...last.entries, entry] }];
      }
      return [...acc, { date: entry.date, dateSpan: entry.totalRows, entries: [entry] }];
    }, []);
    return groups.flatMap((g) => g.entries.map((entry, idx) => ({
      ...entry,
      dateSpan: g.dateSpan,
      isFirstOfDate: idx === 0
    })));
  }, [filtered]);

  const inputClass =
    "w-full bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition";
  const labelClass =
    "block text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5";

  return (
    <section className="p-4 md:p-6" dir="ltr">
      <div className="mb-6">
        <h2 className="text-xl md:text-2xl font-bold text-white">Travaux de Réfection</h2>
        <p className="text-sm text-slate-400 mt-1">
          Record renovation and repair works — manual entry
        </p>
      </div>

      {mode === null ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
            <button
              type="button"
              onClick={() => selectMode('complete')}
              className="flex flex-col items-start gap-2 bg-slate-900/50 backdrop-blur-md border border-slate-700/60 hover:border-emerald-500/50 rounded-2xl p-6 shadow-lg text-left transition"
            >
              <span className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <Check className="w-5 h-5 text-emerald-400" />
              </span>
              <span className="text-lg font-bold text-white">Terminées</span>
              <span className="text-sm text-slate-400">{completeCount} entrée{completeCount > 1 ? 's' : ''}</span>
            </button>
            <button
              type="button"
              onClick={() => selectMode('incomplete')}
              className="flex flex-col items-start gap-2 bg-slate-900/50 backdrop-blur-md border border-amber-500/40 hover:border-amber-500/60 rounded-2xl p-6 shadow-lg text-left transition"
            >
              <span className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
                <Clock className="w-5 h-5 text-amber-400" />
              </span>
              <span className="text-lg font-bold text-white">Non terminées</span>
              <span className="text-sm text-slate-400">{incompleteCount} entrée{incompleteCount > 1 ? 's' : ''}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-6">
            <button
              type="button"
              onClick={backToChoice}
              className="flex items-center gap-1.5 text-xs font-bold text-slate-300 hover:text-white bg-slate-900/60 hover:bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 transition"
            >
              <ArrowLeft className="w-4 h-4" />
              Choisir
            </button>
            <h3 className="text-lg font-bold text-white">
              {mode === 'incomplete' ? 'Non terminées' : 'Terminées'}
            </h3>
          </div>

      {/* FORM CARD */}
      <div className={`bg-slate-900/50 backdrop-blur-md border ${editingId ? 'border-yellow-500/50 shadow-yellow-500/10' : 'border-slate-700/60'} rounded-2xl p-5 md:p-6 shadow-lg max-w-5xl mb-6 transition-colors duration-300`}>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <div className={`w-7 h-7 rounded-lg ${editingId ? 'bg-yellow-500/10 border-yellow-500/20' : 'bg-cyan-500/10 border-cyan-500/20'} border flex items-center justify-center`}>
              {editingId ? <Pencil className="w-4 h-4 text-yellow-400" /> : <Wrench className="w-4 h-4 text-cyan-400" />}
            </div>
            <h3 className={`text-xs font-bold ${editingId ? 'text-yellow-400' : 'text-slate-300'} uppercase tracking-wider`}>
              {editingId ? 'Edit Entry' : 'New Entry — Refection'}
            </h3>
          </div>
          {editingId && (
            <button
              onClick={resetForm}
              className="text-xs font-bold text-slate-400 hover:text-white transition"
            >
              Cancel Edit
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className={labelClass}>Date</label>
            <input name="date" type="date" value={formData.date} onChange={handleChange} className={inputClass} />
          </div>

          <div>
            <label className={labelClass}>Reference</label>
            <input name="reference" value={formData.reference} onChange={handleChange} placeholder="e.g. PLA-089/26" className={inputClass} />
          </div>

          <div>
            <label className={labelClass}>Type</label>
            <select name="type" value={formData.type} onChange={handleChange} className={inputClass}>
              <option value="Refection">Refection</option>
              <option value="Leak">Leak</option>
              <option value="Maintenance">Maintenance</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 mt-4">
          <div>
            <label className={labelClass}>Adresse</label>
            <input name="address" value={formData.address || ''} onChange={handleChange} placeholder="Adresse du chantier, ex: Rue, Quartier, Ville" className={inputClass} />
          </div>
        </div>


        {formData.incomplete && (
          <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="flex items-center justify-between mb-3">
              <label className={labelClass}>Reste à faire (par nature)</label>
              <button
                type="button"
                onClick={addRemaining}
                className="flex items-center gap-1.5 text-xs font-bold text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 px-3 py-1.5 rounded-lg transition"
              >
                <Plus className="w-3.5 h-3.5" />
                Ajouter une ligne
              </button>
            </div>

            <div className="space-y-2">
              {remaining.map((rem, idx) => {
                const remPreview = rem.photoData || rem.photoUrl;
                return (
                <div key={idx} className="rounded-xl border border-amber-500/20 bg-slate-900/40 p-3 space-y-2">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <select
                        value={rem.nature}
                        onChange={(e) => handleRemainingChange(idx, 'nature', e.target.value)}
                        className={inputClass}
                      >
                        <option value="">-- Nature --</option>
                        {NATURES.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-3">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={rem.qty}
                        onChange={(e) => handleRemainingChange(idx, 'qty', e.target.value)}
                        placeholder="Quantité"
                        className={inputClass}
                      />
                    </div>
                    <div className="col-span-2">
                      <select
                        value={rem.unit}
                        onChange={(e) => handleRemainingChange(idx, 'unit', e.target.value)}
                        className={inputClass}
                      >
                        {REMAINING_UNITS.map((u) => (
                          <option key={u} value={u}>{u}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeRemaining(idx)}
                        disabled={remaining.length === 1}
                        className="text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg p-2 transition disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {remPreview && (
                      <img
                        src={remPreview}
                        alt="Preuve"
                        onClick={() => window.open(remPreview, '_blank')}
                        className="w-12 h-12 object-cover rounded-lg border border-slate-700 cursor-pointer"
                        title="Voir la preuve"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => restePhotoInputs.current[idx]?.click()}
                      className="flex items-center gap-1.5 text-xs font-bold text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 px-3 py-1.5 rounded-lg transition"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      {remPreview ? 'Changer la photo' : 'Photo'}
                    </button>
                    {remPreview && (
                      <button
                        type="button"
                        onClick={() => removeRemainingPhoto(idx)}
                        className="text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg p-1.5 transition"
                        title="Retirer la photo"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                    <span className="text-[11px] text-slate-500">Preuve de la nature (optionnel)</span>
                    <input
                      type="file"
                      accept="image/*"
                      ref={(el) => { restePhotoInputs.current[idx] = el; }}
                      className="hidden"
                      onChange={(e) => { handleRemainingPhotoPicked(idx, e.target.files?.[0]); e.target.value = ''; }}
                    />
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {!formData.incomplete && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <label className={labelClass}>Measurements (l × L — each with its own nature)</label>
            <button
              type="button"
              onClick={addMeasurement}
              className="flex items-center gap-1.5 text-xs font-bold text-cyan-300 hover:text-cyan-200 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 px-3 py-1.5 rounded-lg transition"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Measurement
            </button>
          </div>

          <div className="space-y-3">
            {measurements.map((m, idx) => {
              const area =
                m.l && m.L
                  ? (parseFloat(m.l) * parseFloat(m.L)).toFixed(2)
                  : '';
              // Béton is no longer offered for new lines, but an entry
              // stored with Béton keeps it selectable while editing.
              const natureOptions = m.nature === 'Béton' ? [...NATURES, 'Béton'] : NATURES;
              return (
                <div key={idx} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-2">
                      <input
                        type="number"
                        step="0.01"
                        value={m.l}
                        onChange={(e) => handleMeasurementChange(idx, 'l', e.target.value)}
                        placeholder="l (m)"
                        className={inputClass}
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        type="number"
                        step="0.01"
                        value={m.L}
                        onChange={(e) => handleMeasurementChange(idx, 'L', e.target.value)}
                        placeholder="L (m)"
                        className={inputClass}
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        readOnly
                        value={area ? `${area} m²` : ''}
                        placeholder="Area"
                        className={`${inputClass} bg-slate-950/60 text-cyan-400 font-semibold`}
                      />
                    </div>
                    <div className="col-span-4">
                      <select
                        value={m.nature}
                        onChange={(e) => handleMeasurementChange(idx, 'nature', e.target.value)}
                        className={inputClass}
                      >
                        <option value="">-- Nature --</option>
                        {natureOptions.map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => removeMeasurement(idx)}
                        disabled={measurements.length === 1}
                        className="text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg p-2 transition disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>)}

        <div className="flex items-center gap-3 mt-6">
          <button
            type="button"
            onClick={() => setIsMapOpen(true)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-sm font-bold transition"
          >
            <MapPin className="w-4 h-4" />
            {mapPoints.length > 0
              ? `Points (${mapPoints.length})`
              : 'Choose Location (Topo Map)'}
          </button>
          {mapPoints.length > 0 && (
            <span className="text-xs text-cyan-400 font-mono truncate max-w-xs">
              {mapPoints.map((p) => p.label).join(', ')}
            </span>
          )}
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className={`text-sm font-bold px-6 py-2.5 rounded-xl transition flex items-center gap-2 disabled:opacity-50 ${editingId ? 'bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/40 text-yellow-300' : 'bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300'}`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : (editingId ? 'Update Entry' : 'Save Entry')}
          </button>
        </div>
      </div>

      {/* TABLE CARD */}
      <div className="bg-slate-900/50 backdrop-blur-md border border-slate-700/60 rounded-2xl p-5 md:p-6 shadow-lg max-w-5xl">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
              <FileDown className="w-4 h-4 text-cyan-400" />
            </div>
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Saved Entries ({filtered.length}{search && ` / ${refections.length}`})
            </h3>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 w-full md:w-auto">
            
            {/* ✅ NEW MONTH FILTER */}
            <div className="relative">
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => { setSelectedMonth(e.target.value); if (e.target.value) setSelectedDay(''); }}
                className="w-full sm:w-auto bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
              />
            </div>

            {/* Single-day filter: picking a day clears the month filter */}
            <div className="relative">
              <input
                type="date"
                value={selectedDay}
                onChange={(e) => { setSelectedDay(e.target.value); if (e.target.value) setSelectedMonth(''); }}
                className="w-full sm:w-auto bg-slate-900/60 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
                title="Filtrer par un seul jour"
              />
            </div>

            <div className="relative">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search entries..."
                className="w-full sm:w-48 bg-slate-900/60 border border-slate-700 rounded-xl pl-9 pr-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 transition"
              />
            </div>

            <button
              onClick={handleGeneratePDF}
              className="bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-sm font-bold px-5 py-2 rounded-xl transition flex items-center justify-center gap-2 whitespace-nowrap"
            >
              <FileDown className="w-4 h-4" />
              Generate PDF
            </button>

            <button
              onClick={handleDayPDF}
              disabled={!selectedDay}
              className="bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-sm font-bold px-5 py-2 rounded-xl transition flex items-center justify-center gap-2 whitespace-nowrap disabled:opacity-40"
              title="Télécharger en PDF les entrées du jour sélectionné"
            >
              <FileDown className="w-4 h-4" />
              PDF du jour
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-500 py-10 text-sm">
            {search || selectedMonth || selectedDay ? 'No matching entries' : 'No entries yet'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-slate-300">
              <thead>
                <tr className="border-b border-slate-700 text-slate-400 uppercase tracking-wider text-[10px]">
                  <th className="text-left py-2 px-2 border-r border-slate-700">Date</th>
                  <th className="text-left py-2 px-2 border-r border-slate-700">Ref</th>
                  <th className="text-left py-2 px-2">Type</th>
                  <th className="text-left py-2 px-2">Adresse</th>
                  <th className="text-left py-2 px-2">Nature</th>
                  <th className="text-center py-2 px-2">l</th>
                  <th className="text-center py-2 px-2">L</th>
                  <th className="text-center py-2 px-2">Area</th>
                  <th className="text-center py-2 px-2">Photo</th>
                  <th className="text-center py-2 px-2">X</th>
                  <th className="text-center py-2 px-2">Y</th>
                  <th className="text-center py-2 px-2">PDF</th>
                  <th className="text-center py-2 px-2">Edit</th>
                  <th className="text-center py-2 px-2">Statut</th>
                  <th className="text-center py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {groupedFiltered.map((r) => {
                  const { mList, pts, totalRows, dateSpan, isFirstOfDate, id } = r;
                  const isEditingRow = editingId === id;
                  // "Reste à faire" text for incomplete entries, shown
                  // under the address in the list.
                  const remainingText = (r.remaining || [])
                    .filter((rem) => rem.nature && rem.qty !== '' && rem.qty != null)
                    .map((rem) => `${rem.nature} ${rem.qty} ${rem.unit || 'm²'}`)
                    .join(', ');

                  const rows = [];
                  for (let i = 0; i < totalRows; i++) {
                    const m = mList[i] || {};
                    const p = pts[i] || null;
                    const isFirst = i === 0;
                    const area =
                      m.l && m.L
                        ? (parseFloat(m.l) * parseFloat(m.L)).toFixed(2)
                        : '';
                        
                    rows.push(
                      <tr key={`${id}-${i}`} className={`border-b border-slate-800 hover:bg-white/5 ${isEditingRow ? 'bg-yellow-500/5' : ''}`}>
                        {isFirst && (
                          <>
                            {isFirstOfDate && (
                              <td rowSpan={dateSpan} className="py-2 px-2 align-top border-r border-slate-700">{r.date}</td>
                            )}
                            <td rowSpan={totalRows} className="py-2 px-2 align-top border-r border-slate-700">
                              <div>{r.reference}</div>
                              {r.incomplete === true && (
                                <span className="mt-1 inline-block text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded px-1.5 py-0.5">Incomplète</span>
                              )}
                            </td>
                            <td rowSpan={totalRows} className="py-2 px-2 align-top">{r.type}</td>
                            <td rowSpan={totalRows} className="py-2 px-2 align-top">
                              <div>{r.address || ''}</div>
                              {r.incomplete === true && remainingText && (
                                <div className="mt-1 text-[10px] text-amber-300/90">Reste : {remainingText}</div>
                              )}
                              {r.incomplete === true && (r.remaining || []).some((rem) => rem.photoUrl) && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {(r.remaining || []).filter((rem) => rem.photoUrl).map((rem, ri) => (
                                    <img
                                      key={ri}
                                      src={rem.photoUrl}
                                      alt={rem.nature || 'Preuve'}
                                      onClick={() => window.open(rem.photoUrl, '_blank')}
                                      className="w-8 h-8 object-cover rounded cursor-pointer border border-slate-700"
                                      title={`Preuve — ${rem.nature || ''}`}
                                    />
                                  ))}
                                </div>
                              )}
                            </td>
                          </>
                        )}
                        <td className="py-2 px-2">{m.nature || ''}</td>
                        <td className="text-center py-2 px-2">{m.l || ''}</td>
                        <td className="text-center py-2 px-2">{m.L || ''}</td>
                        <td className="text-center py-2 px-2 text-cyan-400 font-semibold">{area ? `${area} m²` : ''}</td>
                        <td className="text-center py-2 px-2">
                          {m.photoUrl ? (
                            <img
                              src={m.photoUrl}
                              alt="Preuve"
                              onClick={() => window.open(m.photoUrl, '_blank')}
                              className="w-8 h-8 object-cover rounded cursor-pointer mx-auto border border-slate-700"
                              title="Voir la preuve"
                            />
                          ) : ''}
                        </td>
                        <td className="text-center py-2 px-2 font-mono text-[10px]">
                          {p ? (p.label ? `${p.label}: ` : '') + (p.x ?? '') : ''}
                        </td>
                        <td className="text-center py-2 px-2 font-mono text-[10px]">
                          {p ? (p.y ?? '') : ''}
                        </td>
                        {isFirst && (
                          <>
                            <td rowSpan={totalRows} className="text-center py-2 px-2 align-top">
                              <button
                                onClick={() => handleSingleDownload(r)}
                                className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-lg p-1.5 transition flex items-center gap-1 mx-auto font-bold"
                                title="Télécharger cette entrée seule en PDF"
                              >
                                <FileDown className="w-3.5 h-3.5" />
                                <span className="text-[11px]">PDF</span>
                              </button>
                            </td>
                            <td rowSpan={totalRows} className="text-center py-2 px-2 align-top">
                              <button
                                onClick={() => handleEditClick(r)}
                                className={`rounded-lg p-1.5 transition ${isEditingRow ? 'text-yellow-400 bg-yellow-500/10' : 'text-slate-400 hover:text-white hover:bg-slate-700'}`}
                                title="Edit Entry"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            </td>
                            <td rowSpan={totalRows} className="text-center py-2 px-2 align-top">
                              {mode === 'incomplete' ? (
                                <button
                                  onClick={() => handleToggleStatus(r, false)}
                                  className="text-emerald-300 hover:text-emerald-200 hover:bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-2 py-1.5 transition text-[11px] font-bold whitespace-nowrap"
                                  title="Marquer cette entrée terminée"
                                >
                                  Terminer
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleToggleStatus(r, true)}
                                  className="text-amber-300 hover:text-amber-200 hover:bg-amber-500/10 border border-amber-500/30 rounded-lg px-2 py-1.5 transition text-[11px] font-bold whitespace-nowrap"
                                  title="Rouvrir cette entrée (non terminée)"
                                >
                                  Rouvrir
                                </button>
                              )}
                            </td>
                            <td rowSpan={totalRows} className="text-center py-2 px-2 align-top">
                              <button
                                onClick={() => handleDelete(r.id)}
                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg p-1.5 transition"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  }
                  return rows;
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}

      <TopoMapPicker
        isOpen={isMapOpen}
        onClose={() => setIsMapOpen(false)}
        onConfirm={(pts) => setMapPoints(pts)}
        initialPoints={mapPoints}
      />
    </section>
  );
};