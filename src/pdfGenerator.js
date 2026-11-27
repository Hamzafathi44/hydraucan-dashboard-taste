// Batch 2: jspdf is loaded on demand (dynamic import) instead of
// statically, so it is not part of the first-load bundle — it is only
// fetched when a PDF is actually generated.
import { toast } from 'sonner';

// Helper to convert images to Base64
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

const formatPoints = (points) => {
  if (!points || points.length === 0) return { x: '', y: '' };
  const xText = points
    .map((p) => `${p.label || ''}: ${p.x ?? ''}`)
    .join('\n');
  const yText = points
    .map((p) => `${p.y ?? ''}`)
    .join('\n');
  return { x: xText, y: yText };
};

const buildBody = (entries) => {
  const body = [];
  const merges = [];

  const expanded = entries.map(entry => {
    const hasMeasurements = entry.measurements && entry.measurements.length > 0;
    const cleanRemaining = (entry.remaining || [])
      .filter((rem) => rem.nature && rem.qty !== '' && rem.qty != null);
    // Incomplete entries hold no measurements (copy, 2026-11-27): do
    // not render an empty measurement row for them — their "Reste à
    // faire" lines are the rows instead (nature / qty / unit).
    const mList = hasMeasurements
      ? entry.measurements
      : cleanRemaining.length > 0
        ? cleanRemaining.map((rem) => ({ nature: rem.nature, l: String(rem.qty), L: rem.unit || 'm²' }))
        : [{ l: entry.l || '', L: entry.L || '', nature: entry.nature || entry.terrainNature || '' }];
    const pts = formatPoints(entry.points);
    const totalRows = Math.max(mList.length, entry.points ? entry.points.length : 1);
    return { entry, mList, pts, totalRows, renderedRemainingAsRows: !hasMeasurements && cleanRemaining.length > 0 };
  });

  // Group by Date
  let currentRow = 0;
  let i = 0;
  while (i < expanded.length) {
    let j = i + 1;
    let dateSpan = expanded[i].totalRows;
    while (j < expanded.length && expanded[j].entry.date === expanded[i].entry.date) {
      dateSpan += expanded[j].totalRows;
      j++;
    }

    if (dateSpan > 1) {
      merges.push({ col: 0, startRow: currentRow, rowSpan: dateSpan });
    }

    for (let k = i; k < j; k++) {
      const { entry, mList, pts, totalRows, renderedRemainingAsRows } = expanded[k];

      if (totalRows > 1) {
        merges.push({ col: 1, startRow: currentRow, rowSpan: totalRows }); // Ref
        merges.push({ col: 2, startRow: currentRow, rowSpan: totalRows }); // Type
        merges.push({ col: 3, startRow: currentRow, rowSpan: totalRows }); // Matériel Utilisé
      }

      // Incomplete entries (copy, 2026-11-27): the Type cell carries the
      // "Incomplète" marker. When the reste lines are rendered as rows
      // (no measurements), the address cell does NOT repeat them; when
      // the entry has measurements too (older incomplete entries), the
      // address cell lists what is left ("Reste : ..."), in both the
      // per-entry and the monthly PDF. Photos stay in the app only.
      const isIncomplete = entry.incomplete === true;
      const remainingText = (entry.remaining || [])
        .filter((rem) => rem.nature && rem.qty !== '' && rem.qty != null)
        .map((rem) => `${rem.nature} ${rem.qty} ${rem.unit || 'm²'}`)
        .join(', ');

      mList.forEach((m, idx) => {
        const isFirst = idx === 0;
        body.push([
          isFirst && k === i ? (entry.date || '') : '',
          isFirst ? (entry.reference || '') : '',
          isFirst ? ((entry.type || '') + (isIncomplete ? ' (Incomplète)' : '')) : '',
          isFirst ? ((entry.address || entry.material || '') + (isIncomplete && remainingText && !renderedRemainingAsRows ? `\nReste : ${remainingText}` : '')) : '',
          m.nature || '',
          m.l || '',
          m.L || '',
          pts.x,
          pts.y
        ]);
      });
      currentRow += totalRows;
    }
    i = j;
  }

  return { body, merges };
};

export const generateReportPDF = async (filteredList, selectedMonth, customTitle) => {
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

  try {
    const logoData = await toBase64('/logo-hydracane.png');
    doc.addImage(logoData, 'PNG', 14, 10, 30, 12);
  } catch {
    console.warn("Logo non trouvé");
  }

  // Single-entry download (copy, 2026-10-29): previously a single entry was
  // exported with the same "Rapport Mensuel - YYYY-MM" title and filename
  // as the whole month's PDF, so it looked like there was no single option
  // at all. A custom title now makes the single PDF visibly its own document.
  const title = customTitle || (selectedMonth === 'Tous' ? "Rapport Mensuel - Global" : `Rapport Mensuel - ${selectedMonth}`);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(title, 148, 25, { align: 'center' });

  const hasAddress = filteredList && filteredList.some((e) => e.address);
  const materialHeader = hasAddress ? "Adresse" : "Matériel Utilisé";
  const { body, merges } = buildBody(filteredList);

  autoTable(doc, {
    head: [["DATE", "Références", "Type", materialHeader, "Nature", "l", "L", "X", "Y"]],
    body: body,
    startY: 40,
    theme: 'grid',
    headStyles: {
      fillColor: [60, 179, 143],
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      halign: 'center',
      valign: 'middle'
    },
    didParseCell: function (data) {
      if (data.cell.section === 'body') {
        merges.forEach(({ col, startRow, rowSpan }) => {
          if (data.column.index === col) {
            if (data.row.index === startRow) {
              data.cell.rowSpan = rowSpan;
              data.cell.styles.valign = 'middle';
            } else if (
              data.row.index > startRow &&
              data.row.index < startRow + rowSpan
            ) {
              data.cell.text = [''];
            }
          }
        });
      }
    },
    columnStyles: {
      0: { cellWidth: 25 },
      1: { cellWidth: 30 },
      2: { cellWidth: 20 },
      3: { cellWidth: 30 },
      4: { cellWidth: 25 },
      5: { cellWidth: 15 },
      6: { cellWidth: 15 },
      7: { cellWidth: 35 },
      8: { cellWidth: 30 }
    },
    styles: {
      valign: 'middle',
      halign: 'center',
      fontSize: 9,
      cellPadding: 2
    }
  });

  const safeFilename = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'rapport';
  doc.save(`${safeFilename}.pdf`);
  toast.dismiss(loadingToast);
  toast.success("PDF exporté avec succès");
};

// New PDF form for non-completed Réfection entries (copy, 2026-11-27):
// a distinct "Reste à faire" form — NOT the complete entries'
// measurement table. Per entry: date / reference / type / address,
// then a Date | Nature | Quantité restante | Unité | Photo table of what is
// still needed (date shown once, on the first row of the entry's table,
// like the completed PDF's merged-date style), plus a summary totalling
// nature + unit. Photos are links, not images: the Photo column shows a
// short clickable "Voir photo" link, so the photo takes no vertical
// space in the PDF and still opens with one tap.
const formatQtyTotal = (n) => {
  if (n == null || Number.isNaN(n)) return '';
  return String(Math.round(n * 100) / 100);
};

export const generateIncompleteReportPDF = async (filteredList, selectedMonth, customTitle) => {
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

  // Detail used in the subtitle and the filename: the custom title
  // without a leading "Réfection - " (single/day exports), or the
  // month (monthly export).
  const detail = customTitle
    ? customTitle.replace(/^Réfection\s*-\s*/, '')
    : (selectedMonth === 'Tous' ? 'Global' : (selectedMonth || ''));
  const fileTitle = `Réfection non terminée - ${detail || 'Reste à faire'}`;

  const doc = new jsPDF('portrait', 'mm', 'a4');
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;

  try {
    const logoData = await toBase64('/logo-hydracane.png');
    doc.addImage(logoData, 'PNG', 14, 10, 30, 12);
  } catch {
    console.warn("Logo non trouvé");
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(22, 41, 77);
  doc.text("Réfection non terminée — Reste à faire", pageWidth / 2, 22, { align: 'center' });
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  if (detail) {
    doc.text(detail, pageWidth / 2, 29, { align: 'center' });
  }

  // Amber "NON TERMINÉE" badge, top right.
  doc.setFillColor(245, 158, 11);
  doc.roundedRect(pageWidth - 46, 12, 32, 8, 2, 2, 'F');
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text("NON TERMINÉE", pageWidth - 30, 17.2, { align: 'center' });

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  doc.text(`Nombre d'entrées : ${filteredList ? filteredList.length : 0}`, margin, 38);

  const cleanRemainingOf = (entry) => (entry.remaining || [])
    .filter((rem) => rem.nature && rem.qty !== '' && rem.qty != null);

  const entries = (filteredList || []).map((entry) => ({
    entry,
    lines: cleanRemainingOf(entry).map((rem) => ({
      nature: rem.nature,
      qty: rem.qty,
      unit: rem.unit || 'm²',
      photoUrl: rem.photoUrl || null
    }))
  }));

  let y = 44;

  for (const { entry, lines } of entries) {
    // Start a new page if there is not enough room left for the entry
    // header + a few rows.
    if (y > 250) {
      doc.addPage();
      y = 20;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(22, 41, 77);
    doc.text(`${entry.date || ''}  —  ${entry.reference || 'sans référence'}`, margin, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    const meta = [entry.type || '', entry.address || ''].filter(Boolean).join('  •  ');
    if (meta) {
      const metaLines = doc.splitTextToSize(meta, contentWidth);
      metaLines.forEach((line) => {
        doc.text(line, margin, y);
        y += 5;
      });
      y += 1;
    }
    doc.setTextColor(0, 0, 0);

    if (lines.length === 0) {
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.text("Aucun reste à faire renseigné.", margin, y);
      doc.setTextColor(0, 0, 0);
      y += 10;
      continue;
    }

    const body = lines.map((line, idx) => [idx === 0 ? (entry.date || '') : '', line.nature, String(line.qty), line.unit, line.photoUrl ? 'Voir photo' : '—']);
    autoTable(doc, {
      head: [["Date", "Nature", "Quantité restante", "Unité", "Photo"]],
      body,
      startY: y,
      margin: { left: margin, right: margin },
      theme: 'grid',
      headStyles: {
        fillColor: [22, 41, 77],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'center',
        valign: 'middle'
      },
      columnStyles: {
        0: { cellWidth: 28, halign: 'center' },
        1: { cellWidth: 45 },
        2: { cellWidth: 35, halign: 'center' },
        3: { cellWidth: 20, halign: 'center' },
        4: { cellWidth: contentWidth - 128, halign: 'center' }
      },
      styles: { valign: 'middle', halign: 'left', fontSize: 10, cellPadding: 2 },
      didParseCell: function (data) {
        // Link cells read as links: blue text on rows that have a photo.
        if (data.cell.section === 'body' && data.column.index === 4) {
          const line = lines[data.row.index];
          if (line && line.photoUrl) {
            data.cell.styles.textColor = [37, 99, 235];
          }
        }
      },
      didDrawCell: function (data) {
        // Make the "Voir photo" cell a real clickable link to the photo,
        // and underline it like a link. The photo itself is never drawn,
        // so it takes no vertical space in the PDF.
        if (data.cell.section === 'body' && data.column.index === 4) {
          const line = lines[data.row.index];
          if (line && line.photoUrl) {
            doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url: line.photoUrl });
            const text = 'Voir photo';
            const textWidth = doc.getTextWidth(text);
            const x0 = data.cell.x + (data.cell.width - textWidth) / 2;
            const underlineY = data.cell.y + data.cell.height / 2 + 2.5;
            doc.setDrawColor(37, 99, 235);
            doc.setLineWidth(0.2);
            doc.line(x0, underlineY, x0 + textWidth, underlineY);
          }
        }
      }
    });
    y = doc.lastAutoTable.finalY + 8;
  }

  // Summary: total remaining per nature + unit across all entries.
  const totals = {};
  entries.forEach(({ lines }) => {
    lines.forEach((line) => {
      const qty = parseFloat(String(line.qty).replace(',', '.'));
      if (Number.isNaN(qty)) return;
      const key = `${line.nature}||${line.unit}`;
      totals[key] = (totals[key] || 0) + qty;
    });
  });
  const totalRows = Object.entries(totals).map(([key, qty]) => {
    const [nature, unit] = key.split('||');
    return [nature, formatQtyTotal(qty), unit];
  });

  if (y > 250) {
    doc.addPage();
    y = 20;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(15, 118, 110);
  doc.text("Total restant par nature", margin, y);
  y += 4;
  if (totalRows.length === 0) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(120, 120, 120);
    doc.text("Aucune quantité restante.", margin, y + 4);
  } else {
    autoTable(doc, {
      head: [["Nature", "Total restant", "Unité"]],
      body: totalRows,
      startY: y,
      margin: { left: margin, right: margin },
      theme: 'grid',
      headStyles: {
        fillColor: [15, 118, 110],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
        halign: 'center',
        valign: 'middle'
      },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { cellWidth: 50, halign: 'center' },
        2: { cellWidth: 30, halign: 'center' }
      },
      styles: { valign: 'middle', halign: 'left', fontSize: 10, cellPadding: 2 }
    });
  }

  const safeFilename = fileTitle.replace(/[\\/:*?"<>|]/g, '').trim() || 'reste-a-faire';
  doc.save(`${safeFilename}.pdf`);
  toast.dismiss(loadingToast);
  toast.success("PDF exporté avec succès");
};
