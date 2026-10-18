'use client';
import PickerControl, { PickerOption } from './PickerControl';
import { ENDPOINT_ENGINES, endpointModelCheck, endpointModels, endpointParameters, type CustomEndpoint, type EndpointModel } from '@/lib/customEndpoints';
import { providerName } from '@/lib/providerText';
import { modelAxes } from '@/lib/modelParams';
import { formatPrice, priceTier } from '@/lib/modelPricing';
import { endpointModelFamily, groupEndpointModels, isNewEndpointModel } from '@/lib/endpointModelCatalog';

const tokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${+(n / 1000).toFixed(1)}K`;
export default function EndpointModelPicker({ endpoint, kind, value, onChange, presentation, disabled, includeUnverified = false, id, 'aria-label': label }: {
  endpoint: CustomEndpoint; kind: string; value: string; onChange: (id: string) => void;
  presentation?: 'select' | 'list'; disabled?: boolean; includeUnverified?: boolean; id?: string; 'aria-label'?: string;
}) {
  const models = [...endpointModels(endpoint, kind, includeUnverified)];
  if (value && !models.some((m) => m.id === value)) models.unshift(endpoint.models?.find((m) => m.id === value) || { id: value });
  const now = Date.now();
  return <PickerControl id={id} aria-label={label} presentation={presentation} disabled={disabled} value={value} onValueChange={onChange}>
    {!value && <option value="" disabled>Choose a model</option>}
    {groupEndpointModels(models, now).map((group) => <optgroup key={group.label} label={group.label}>
      {group.models.map((m) => <option key={m.id} value={m.id} data-search={`${m.id} ${m.info?.name || ''} ${endpointModelFamily(m)} ${m.info?.description || ''}`}>
        <EndpointModelOption model={m} endpoint={endpoint} kind={kind} isNew={isNewEndpointModel(m, now)} showCompatibility={includeUnverified} />
      </option>)}
    </optgroup>)}
  </PickerControl>;
}
function compatibilityLines(endpoint: CustomEndpoint, model: string): string[] {
  return ENDPOINT_ENGINES.map((engine) => {
    const check = endpointModelCheck(endpoint, engine, model);
    const status = check?.ok ? 'Available (verified)' : check ? `Last test failed${check.error ? `: ${check.error}` : ''}` : 'Not tested';
    return `${providerName(engine)} · ${status}`;
  });
}

function CompatibilityBadges({ endpoint, model, kind }: { endpoint: CustomEndpoint; model: string; kind: string }) {
  const labels = compatibilityLines(endpoint, model);
  return <span className="endpoint-model-badges">{ENDPOINT_ENGINES.map((engine, index) => {
    const check = endpointModelCheck(endpoint, engine, model);
    const state = check?.ok ? 'verified' : check ? 'failed' : 'unknown';
    return <span key={engine} className="endpoint-model-badge" data-state={state} data-current={engine === kind || undefined}
      title={labels[index]} aria-label={labels[index]}>
      <span aria-hidden="true">{check?.ok ? '✓' : check ? '×' : '?'}</span>{providerName(engine)}
    </span>;
  })}</span>;
}

export function EndpointModelCompatibility({ endpoint, model }: { endpoint: CustomEndpoint; model: string }) {
  return <div aria-label="Model compatibility">{compatibilityLines(endpoint, model).map((line) => <p className="set-meta" key={line}>{line}</p>)}</div>;
}

function EndpointModelOption({ model: m, endpoint, kind, isNew, showCompatibility }: { model: EndpointModel; endpoint: CustomEndpoint; kind: string; isNew: boolean; showCompatibility: boolean }) {
  const info = m.info;
  const tier = priceTier(info?.price);
  const price = formatPrice(info?.price);
  const facts = modelAxes({ id: m.id, label: info?.name || m.id, parameters: endpointParameters(endpoint, kind, m.id) }).facts;
  const check = endpointModelCheck(endpoint, kind, m.id);
  const state = showCompatibility ? check?.ok ? 'verified' : check ? 'failed' : 'unknown' : undefined;
  return <span className="endpoint-model-choice" data-state={state}><PickerOption title={<>
    {info?.name || m.id}{isNew && <span className="endpoint-model-new" title={`Released ${info?.releaseDate}`}>New</span>}{tier && <span className="picker-tier">{tier}</span>}
    {showCompatibility && <CompatibilityBadges endpoint={endpoint} model={m.id} kind={kind} />}
  </>} sub={[
    info?.name && info.name !== m.id ? m.id : null,
    price ? `Catalog base rate · ${price}` : null,
    m.contextWindow ? `${tokens(m.contextWindow)} context` : null,
    info?.outputTokens ? `${tokens(info.outputTokens)} max output` : null,
    info?.input?.length ? `Input: ${info.input.join(', ')}` : null,
    ...facts,
    info?.reasoning && !facts.length ? 'Reasoning · model default' : null,
    info?.tieredPrice ? 'Higher rates for long context' : null,
    info?.description || null,
  ]} /></span>;
}
