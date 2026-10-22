'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { FsSqliteResponse, SqliteCell, SqliteObject } from '@/lib/types/api';
import type { ByteViewerProps } from './fileViews';
import HexViewer from './HexViewer';
import { fmtSize } from './sessionAttachments';

const PAGE = 200;

/**
 * A SQLite database, read-only (§14.112): tables and views with their row
 * counts, rows by pages of 200, each object's schema, and a SQL console for
 * one SELECT at a time (Ctrl/⌘+Enter). The agent refuses anything that would
 * write; a file that turns out not to be SQLite falls back to the hex view.
 */
export default function SqliteViewer({ vpsId, root, path, rev }: ByteViewerProps) {
  const [schema, setSchema] = useState<FsSqliteResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<'rows' | 'schema' | 'sql'>('rows');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<FsSqliteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [sql, setSql] = useState('');

  useEffect(() => {
    let alive = true;
    void api.fsSqlite(vpsId, { root, path, op: 'schema' }).then((r) => {
      if (!alive) return;
      setSchema(r);
      const tables = (r.objects ?? []).filter((o) => o.type === 'table' || o.type === 'view');
      // Open on something to read: the first table with rows, else the first.
      const first = tables.find((t) => t.type === 'table' && (t.rows ?? 0) > 0) ?? tables[0];
      setSelected((cur) => (cur && tables.some((t) => t.name === cur) ? cur : first?.name ?? null));
    }, (e: unknown) => { if (alive) setSchema({ ok: false, error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [vpsId, root, path, rev]);

  const objects = schema?.objects ?? [];
  const browsable = objects.filter((o) => o.type === 'table' || o.type === 'view');
  const others = objects.filter((o) => o.type === 'index' || o.type === 'trigger');
  const current = objects.find((o) => o.name === selected) ?? null;

  const run = useCallback(async (statement: string, params: (string | number)[] = []) => {
    setBusy(true);
    try {
      setResult(await api.fsSqlite(vpsId, { root, path, op: 'query', sql: statement, params, limit: PAGE }));
    } catch (e: unknown) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [vpsId, root, path]);

  // Browsing a table: one page of rows, in rowid order.
  useEffect(() => {
    if (mode !== 'rows' || !selected) return;
    void run(`SELECT * FROM "${selected.replace(/"/g, '""')}" LIMIT ${PAGE} OFFSET ${page * PAGE}`);
  }, [mode, selected, page, run, rev]);

  if (schema && !schema.ok) {
    if (schema.reason === 'format') {
      return (
        <div className="sqlv">
          <div className="dvm-note">not a SQLite database — showing the raw bytes</div>
          <HexViewer vpsId={vpsId} root={root} path={path} rev={rev} />
        </div>
      );
    }
    return <div className="sqlv"><div className="dvm-note err">{schema.error ?? 'could not open this database'}</div></div>;
  }

  const total = current?.rows ?? null;
  return (
    <div className="sqlv">
      <div className="viewer-bar">
        <span className="viewer-bar-note">
          {schema ? `SQLite · ${browsable.length} table${browsable.length === 1 ? '' : 's'}/view${browsable.length === 1 ? '' : 's'}${schema.size != null ? ` · ${fmtSize(schema.size)}` : ''} · read-only` : 'opening…'}
        </span>
        <span className="viewer-bar-spacer" />
        <button type="button" className={mode === 'rows' ? 'on' : ''} onClick={() => setMode('rows')}>Rows</button>
        <button type="button" className={mode === 'schema' ? 'on' : ''} onClick={() => setMode('schema')}>Schema</button>
        <button type="button" className={mode === 'sql' ? 'on' : ''}
                onClick={() => {
                  setMode('sql');
                  if (!sql && selected) setSql(`SELECT * FROM "${selected.replace(/"/g, '""')}" LIMIT 100`);
                }}>SQL</button>
      </div>
      <div className="sqlv-body">
        <nav className="sqlv-list" aria-label="Tables">
          {browsable.map((o) => (
            <button type="button" key={o.name} className={`sqlv-item${o.name === selected ? ' on' : ''}`}
                    onClick={() => { setSelected(o.name); setPage(0); if (mode === 'sql') setMode('rows'); }}
                    title={o.type === 'view' ? `view ${o.name}` : `table ${o.name}`}>
              <span className="sqlv-name">{o.type === 'view' ? '◇ ' : ''}{o.name}</span>
              <span className="sqlv-count">{o.rows == null ? '' : o.rows.toLocaleString()}</span>
            </button>
          ))}
          {others.length > 0 && (
            <details className="sqlv-others">
              <summary>{others.length} index{others.length === 1 ? '' : 'es'}/trigger{others.length === 1 ? '' : 's'}</summary>
              {others.map((o) => (
                <button type="button" key={o.name} className={`sqlv-item${o.name === selected ? ' on' : ''}`}
                        onClick={() => { setSelected(o.name); setMode('schema'); }}>
                  <span className="sqlv-name">{o.name}</span>
                  <span className="sqlv-count">{o.type}</span>
                </button>
              ))}
            </details>
          )}
          {schema?.ok && browsable.length === 0 && <div className="dvm-note">empty database</div>}
        </nav>
        <section className="sqlv-main">
          {mode === 'schema' && current && <SchemaPane object={current} />}
          {mode === 'sql' && (
            <div className="sqlv-console">
              <textarea
                className="sqlv-sql"
                value={sql}
                spellCheck={false}
                placeholder="SELECT … (read-only)"
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(sql); }
                }}
              />
              <div className="sqlv-run">
                <button type="button" className="wiz-btn primary" disabled={busy || !sql.trim()}
                        onClick={() => void run(sql)}>{busy ? 'running…' : 'Run'}</button>
                <span className="sqlv-hint">Ctrl/⌘+Enter · one statement · at most {PAGE} rows · nothing is ever written</span>
              </div>
            </div>
          )}
          {(mode === 'rows' || mode === 'sql') && (
            <>
              {mode === 'rows' && current && (
                <div className="sqlv-pager">
                  <span>
                    {total == null ? `page ${page + 1}`
                      : total === 0 ? 'empty table'
                      : `rows ${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)} of ${total.toLocaleString()}`}
                  </span>
                  <button type="button" disabled={page === 0 || busy} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
                  <button type="button" disabled={busy || (total != null ? (page + 1) * PAGE >= total : !result?.truncated)}
                          onClick={() => setPage((p) => p + 1)}>Next ›</button>
                </div>
              )}
              {result && !result.ok && <div className="dvm-note err">{result.error}</div>}
              {result?.ok && (
                <>
                  {mode === 'sql' && (
                    <div className="sqlv-meta">
                      {result.rows?.length ?? 0} row{result.rows?.length === 1 ? '' : 's'}
                      {result.truncated ? ` (first ${PAGE})` : ''} · {result.elapsedMs ?? 0} ms
                    </div>
                  )}
                  <SqlGrid columns={result.columns ?? []} rows={result.rows ?? []} />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function SchemaPane({ object }: { object: SqliteObject }) {
  return (
    <div className="sqlv-schema">
      {object.columns && object.columns.length > 0 && (
        <table className="sqlv-grid">
          <thead><tr><th>column</th><th>type</th><th>key</th></tr></thead>
          <tbody>
            {object.columns.map((c) => (
              <tr key={c.name}><td>{c.name}</td><td>{c.type || '—'}</td><td>{c.pk ? 'PK' : ''}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <pre className="sqlv-ddl">{object.sql ?? '(no SQL — an automatic index)'}</pre>
    </div>
  );
}

function cellText(c: SqliteCell): { text: string; cls: string; title?: string } {
  if (c === null) return { text: 'NULL', cls: 'null' };
  if (typeof c === 'number') return { text: String(c), cls: 'num' };
  if (typeof c === 'boolean') return { text: String(c), cls: 'num' };
  if (typeof c === 'string') return { text: c, cls: '', title: c.length > 80 ? c : undefined };
  if ('$blob' in c) return { text: `‹blob ${fmtSize(c.$blob)}›`, cls: 'blob', title: `${c.hex}${c.$blob > 32 ? '…' : ''}` };
  return { text: `${c.$text}…`, cls: '', title: `${c.length.toLocaleString()} characters` };
}

function SqlGrid({ columns, rows }: { columns: string[]; rows: SqliteCell[][] }) {
  const body = useMemo(() => rows.map((r) => r.map(cellText)), [rows]);
  if (!columns.length) return <div className="dvm-note">no rows</div>;
  return (
    <div className="sqlv-grid-scroll">
      <table className="sqlv-grid">
        <thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => <td key={j} className={c.cls} title={c.title}>{c.text}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
