import { useState, useMemo, useRef } from 'react';
import { generateReportPDF } from '../pdfGenerator';
import { useRefections } from '../hooks/useRefections';
import TopoMapPicker from '../components/TopoMapPicker';
import {
  Wrench, FileDown, Save, Trash2, Loader2, Search, Plus, X, MapPin, Pencil, Calendar
} from 'lucide-react';
import { toast } from 'sonner';

const NATURES = [
  'argile', 'Béton', 'Pavé', 'Goudron', 'Faience', 'Revsol'
];

export const RefectionView = ({ user }) => {
  const { refections, loading, addRefection, updateRefection, deleteRefection } = useRefections(user);

  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [mapPoints, setMapPoints] = useState([]);
  const [editingId, setEditingId] = useState(null);
  
  // ✅ NEW: State for the Month Filter
  const [selectedMonth, setSelectedMonth] = useState('');
  // Single-day filter + download (copy, 2026-10-29): a day and a month
  // are mutually exclusive — picking one clears the other.
  const [selectedDay, setSelectedDay] = useState('');

  const [formData, setFormData] = useState({
    date: '',
    reference: '',
    type: 'Refection',
    address: ''
  });

  // Two-step delete arming (same pattern as Enveloppe, 2026-11-27):
  // first tap arms the button ("Sûr ?"), second really deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  // Delayed delete (2026-11-27 fix): the entry is only hidden locally
  // for 8s and really deleted when the timer fires, so "Annuler" just
  // cancels the timer. Deleting then re-adding would have stamped a
  // fresh userId/createdAt on the restored copy — for a legacy
  // (ownerless) entry that would silently make it owned by the
  // restorer and hide it from the other employees.
  const [pendingDeleteIds, setPendingDeleteIds] = useState(() => new Set());
  const pendingTimers = useRef({});

  const [measurements, setMeasurements] = useState([
    { l: '', L: '', nature: '' }
  ]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleMeasurementChange = (index, field, value) => {
    const updated = [...measurements];
    updated[index][field] = value;
    setMeasurements(updated);
  };

  const addMeasurement = () => {
    setMeasurements([...measurements, { l: '', L: '', nature: '' }]);
  };

  const removeMeasurement = (index) => {
    if (measurements.length === 1) return;
    setMeasurements(measurements.filter((_, i) => i !== index));
  };

  const resetForm = () => {
    setFormData({ date: '', reference: '', type: 'Refection', address: '' });
    setMeasurements([{ l: '', L: '', nature: '' }]);
    setMapPoints([]);
    setEditingId(null);
  };

  const handleEditClick = (entry) => {
    setFormData({
      date: entry.date || '',
      reference: entry.reference || '',
      type: entry.type || 'Refection',
      address: entry.address || ''
    });
    
    setMeasurements(
      entry.measurements && entry.measurements.length > 0
        ? entry.measurements
        : [{ l: entry.l || '', L: entry.L || '', nature: entry.nature || '' }]
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

    const cleanMeasurements = measurements.filter(
      (m) => m.l !== '' && m.L !== '' && m.nature !== ''
    );

    if (cleanMeasurements.length === 0) {
      toast.error('Add at least one measurement (l, L, nature)');
      return;
    }

    setSaving(true);
    let result;

    if (editingId) {
      result = await updateRefection(editingId, {
        ...formData,
        measurements: cleanMeasurements,
        points: mapPoints
      });
    } else {
      result = await addRefection({
        ...formData,
        measurements: cleanMeasurements,
        points: mapPoints
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

  // Two-step delete + 8s undo (same pattern as Enveloppe, 2026-11-27):
  // the first tap arms the button, the second hides the entry and
  // starts an 8s timer; the entry is only really deleted when the
  // timer fires, and "Annuler" cancels the timer so the entry was
  // never deleted at all — its id, owner (or ownerless legacy status)
  // and createdAt are preserved exactly.
  const handleDelete = (entry) => {
    const id = entry.id;
    setConfirmDeleteId(null);
    if (editingId === id) resetForm();
    setPendingDeleteIds((prev) => new Set(prev).add(id));
    pendingTimers.current[id] = setTimeout(async () => {
      const result = await deleteRefection(id);
      delete pendingTimers.current[id];
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (!result.success) toast.error('Failed to delete');
    }, 8000);
    toast('Entrée supprimée', {
      duration: 8000,
      action: {
        label: 'Annuler',
        onClick: () => {
          clearTimeout(pendingTimers.current[id]);
          delete pendingTimers.current[id];
          setPendingDeleteIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          toast.success('Suppression annulée');
        }
      }
    });
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
    if (pendingDeleteIds.has(r.id)) return false;
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
    return (
      (r.date || '').toLowerCase().includes(searchQuery) ||
      (r.reference || '').toLowerCase().includes(searchQuery) ||
      (r.type || '').toLowerCase().includes(searchQuery) ||
      (r.address || '').toLowerCase().includes(searchQuery) ||
      measurementsText.toLowerCase().includes(searchQuery) ||
      pointsText.toLowerCase().includes(searchQuery)
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

          <div className="space-y-2">
            {measurements.map((m, idx) => {
              const area =
                m.l && m.L
                  ? (parseFloat(m.l) * parseFloat(m.L)).toFixed(2)
                  : '';
              return (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
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
                      value={area}
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
                      {NATURES.map((n) => (
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
              );
            })}
          </div>
        </div>

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
          <>
            <div className="hidden lg:block overflow-x-auto">
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
                  <th className="text-center py-2 px-2">X</th>
                  <th className="text-center py-2 px-2">Y</th>
                  <th className="text-center py-2 px-2">PDF</th>
                  <th className="text-center py-2 px-2">Edit</th>
                  <th className="text-center py-2 px-2"></th>
                </tr>
              </thead>
              <tbody>
                {groupedFiltered.map((r) => {
                  const { mList, pts, totalRows, dateSpan, isFirstOfDate, id } = r;
                  const isEditingRow = editingId === id;

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
                            <td rowSpan={totalRows} className="py-2 px-2 align-top border-r border-slate-700">{r.reference}</td>
                            <td rowSpan={totalRows} className="py-2 px-2 align-top">{r.type}</td>
                            <td rowSpan={totalRows} className="py-2 px-2 align-top">{r.address || ''}</td>
                          </>
                        )}
                        <td className="py-2 px-2">{m.nature || ''}</td>
                        <td className="text-center py-2 px-2">{m.l || ''}</td>
                        <td className="text-center py-2 px-2">{m.L || ''}</td>
                        <td className="text-center py-2 px-2 text-cyan-400 font-semibold">{area}</td>
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
                              <button
                                onClick={() => confirmDeleteId === r.id ? handleDelete(r) : setConfirmDeleteId(r.id)}
                                className={confirmDeleteId === r.id ? 'bg-red-500 text-white text-[11px] font-bold rounded-lg px-2 py-1.5 transition' : 'text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg p-1.5 transition'}
                                title="Delete"
                              >
                                {confirmDeleteId === r.id ? 'Sûr ?' : <Trash2 className="w-3.5 h-3.5" />}
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

            {/* Mobile entry cards (same inline-map pattern as Enveloppe,
                2026-11-27): one card per entry, same actions as the
                desktop row — PDF, Edit, two-step Delete. */}
            <div className="lg:hidden space-y-3">
              {groupedFiltered.map((r) => {
                const pts = (r.pts || []).filter(Boolean);
                const isEditingRow = editingId === r.id;
                return (
                  <article key={r.id} className={`bg-white border rounded-2xl p-3 ${isEditingRow ? 'border-yellow-500/50' : 'border-[#E2E8F0]'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-bold text-[#16294D] num-tabular">{r.date}</span>
                      <span className="shrink-0 bg-[#0F766E]/10 border border-[#0F766E]/30 text-[#0F766E] text-xs font-bold rounded-full px-2.5 py-1 truncate">{r.reference}</span>
                      <span className="ml-auto shrink-0 text-xs text-slate-500">{r.type}</span>
                    </div>
                    {r.address ? <p className="text-xs text-slate-500 mb-2">{r.address}</p> : null}
                    <div className="space-y-1 mb-3">
                      {(r.mList || []).map((m, i) => {
                        const area = m.l && m.L ? (parseFloat(m.l) * parseFloat(m.L)).toFixed(2) : '';
                        return (
                          <div key={i} className="flex items-center justify-between text-xs">
                            <span className="text-slate-700">{m.nature || '—'} · {m.l || '—'} × {m.L || '—'} m</span>
                            <span className="num-tabular font-semibold text-[#0F766E]">{area ? `${area} m²` : '—'}</span>
                          </div>
                        );
                      })}
                    </div>
                    {pts.length > 0 && (
                      <p className="text-[11px] font-mono text-slate-500 mb-3">
                        {pts.map((p) => `${p.label ? `${p.label}: ` : ''}${p.x ?? ''}, ${p.y ?? ''}`).join(' · ')}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSingleDownload(r)}
                        className="flex-1 min-h-11 text-sm font-bold rounded-xl flex items-center justify-center gap-1.5 bg-[#16294D]/5 border border-[#16294D]/30 text-[#16294D]"
                        title="Télécharger cette entrée seule en PDF"
                      >
                        <FileDown className="w-4 h-4" /> PDF
                      </button>
                      <button
                        onClick={() => handleEditClick(r)}
                        className={`flex-1 min-h-11 text-sm font-bold rounded-xl flex items-center justify-center gap-1.5 border ${isEditingRow ? 'bg-yellow-500/10 border-yellow-500/40 text-yellow-600' : 'bg-white border-[#E2E8F0] text-slate-700'}`}
                        title="Edit Entry"
                      >
                        <Pencil className="w-4 h-4" /> Modifier
                      </button>
                      <button
                        onClick={() => confirmDeleteId === r.id ? handleDelete(r) : setConfirmDeleteId(r.id)}
                        className={`flex-1 min-h-11 text-sm font-bold rounded-xl flex items-center justify-center gap-1.5 ${confirmDeleteId === r.id ? 'bg-red-500 text-white' : 'bg-red-500/10 border border-red-500/40 text-red-600'}`}
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" /> {confirmDeleteId === r.id ? 'Sûr ?' : 'Supprimer'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>

      <TopoMapPicker
        isOpen={isMapOpen}
        onClose={() => setIsMapOpen(false)}
        onConfirm={(pts) => setMapPoints(pts)}
        initialPoints={mapPoints}
      />
    </section>
  );
};