import { Calendar as CalendarIcon, PieChart as PieChartIcon, Activity, BarChart3 } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts';

// Taste Skill v2, app sheet framed-sheet: the dashboard is an app
// screen, not a landing page. KPIs are type in one container split
// by 1px dividers (no tiles, no icon chips, no sparklines), colour
// goes on data only (one navy hue, not a rainbow), surfaces are
// flat with a 1px line, tables are rules with right-aligned
// tabular figures, and nothing performs an entrance. All data
// computations below are unchanged from the original.
export const DashboardHome = ({ stats, dataList, chartData }) => {
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 leading-tight">Tableau de bord</h1>
        <p className="text-sm text-slate-500 mt-1">Mois en cours · Travaux hydrauliques, Fquih Ben Salah.</p>
      </header>

      {/* Monthly overview: one KPI strip, not four tiles */}
      <div className="kpi-strip">
        {stats.map((stat) => (
          <div key={stat.label} className="kpi-cell">
            <span className="text-sm text-slate-500">{stat.label}</span>
            <span className="text-2xl font-semibold text-slate-900 tabular-nums">{stat.value}</span>
            {stat.breakdown && (
              <div className="flex items-center gap-3 mt-1 text-xs text-slate-500 tabular-nums">
                <span>RNVL: {stat.breakdown.RNVL || 0}</span>
                <span>FUITE: {stat.breakdown.FUITE || 0}</span>
                <span>F. SP: {stat.breakdown['F. SP'] || 0}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Work Schedule Chart */}
        <div className="bg-white rounded-xl border border-line p-6">
          <div className="flex items-center gap-2 mb-6">
            <CalendarIcon className="w-4 h-4 text-[#16294D]" />
            <h2 className="text-sm font-semibold text-slate-900">Calendrier de travail (mois en cours)</h2>
          </div>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={(() => {
                const now = new Date();
                const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
                const schedule = Array.from({ length: daysInMonth }, (_, i) => ({
                  day: i + 1,
                  count: 0
                }));
                dataList.forEach(item => {
                  const d = new Date(item.date);
                  if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) {
                    const day = d.getDate();
                    if (schedule[day - 1]) schedule[day - 1].count++;
                  }
                });
                return schedule;
              })()}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#EDEDED" />
                <XAxis dataKey="day" fontSize={12} axisLine={false} tickLine={false} stroke="#64748b" />
                <YAxis fontSize={12} axisLine={false} tickLine={false} stroke="#64748b" allowDecimals={false} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #EDEDED' }}
                  itemStyle={{ color: '#101828' }}
                  cursor={{ fill: 'rgba(22,41,77,0.05)' }}
                />
                <Bar dataKey="count" fill="#16294D" radius={[0, 0, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Nature Distribution Chart: one navy hue family, not rainbow */}
        <div className="bg-white rounded-xl border border-line p-6">
          <div className="flex items-center gap-2 mb-6">
            <PieChartIcon className="w-4 h-4 text-[#16294D]" />
            <h2 className="text-sm font-semibold text-slate-900">Répartition par nature</h2>
          </div>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={['#16294D', '#2E4A73', '#5B7AA0', '#8AA0BC', '#C2D0E0', '#E2E6EA'][index % 6]} stroke="#ffffff" />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: '#ffffff', borderRadius: '8px', border: '1px solid #EDEDED', color: '#101828' }} itemStyle={{ color: '#101828' }} />
                <Legend verticalAlign="bottom" height={36} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Material Consumption */}
        <div className="lg:col-span-1 bg-white rounded-xl border border-line p-6">
          <div className="flex items-center gap-2 mb-6">
            <Activity className="w-4 h-4 text-[#16294D]" />
            <h2 className="text-sm font-semibold text-slate-900">Consommation de matériel</h2>
          </div>
          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
            {(() => {
              const now = new Date();
              const materials = dataList
                .filter(item => {
                  const d = new Date(item.date);
                  return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                })
                .reduce((acc, curr) => {
                  if (curr.material) {
                    const mats = curr.material.split(',').map(m => m.trim());
                    mats.forEach(m => {
                      acc[m] = (acc[m] || 0) + 1;
                    });
                  }
                  return acc;
                }, {});

              const sortedMats = Object.entries(materials).sort((a, b) => b[1] - a[1]);

              if (sortedMats.length === 0) return <p className="text-slate-500 text-sm italic">Aucun matériel enregistré ce mois-ci.</p>;

              return sortedMats.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between py-3 border-b border-line last:border-b-0">
                  <span className="text-sm font-medium text-slate-700">{name}</span>
                  <span className="text-sm text-slate-900 tabular-nums">{count} fois</span>
                </div>
              ));
            })()}
          </div>
        </div>

        {/* Nature Summary Table */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-line p-6">
          <div className="flex items-center gap-2 mb-6">
            <BarChart3 className="w-4 h-4 text-[#16294D]" />
            <h2 className="text-sm font-semibold text-slate-900">Résumé des travaux par nature</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="pb-4 text-xs font-medium text-slate-500">Nature du travail</th>
                  <th className="pb-4 text-xs font-medium text-slate-500 text-right">Nombre</th>
                  <th className="pb-4 text-xs font-medium text-slate-500 text-right">Évolution vs mois précédent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {(() => {
                  const now = new Date();
                  const thisMonthNatures = dataList
                    .filter(item => {
                      const d = new Date(item.date);
                      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
                    })
                    .reduce((acc, curr) => {
                      acc[curr.nature] = (acc[curr.nature] || 0) + 1;
                      return acc;
                    }, {});

                  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                  const lastMonthNatures = dataList
                    .filter(item => {
                      const d = new Date(item.date);
                      return d.getMonth() === lastMonth.getMonth() && d.getFullYear() === lastMonth.getFullYear();
                    })
                    .reduce((acc, curr) => {
                      acc[curr.nature] = (acc[curr.nature] || 0) + 1;
                      return acc;
                    }, {});

                  return Object.entries(thisMonthNatures).map(([name, count]) => {
                    const prevCount = lastMonthNatures[name] || 0;
                    const diff = count - prevCount;
                    return (
                      <tr key={name} className="group hover:bg-slate-50 transition-colors">
                        <td className="py-4 text-sm font-medium text-slate-700">{name}</td>
                        <td className="py-4 text-sm font-semibold text-slate-900 text-right tabular-nums">{count}</td>
                        <td className="py-4 text-right">
                          <span className="text-xs font-medium text-slate-500 tabular-nums">
                            {diff >= 0 ? '+' : ''}{diff}
                          </span>
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
