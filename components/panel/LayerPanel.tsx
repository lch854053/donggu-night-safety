import { MAP_LAYER_DEFINITIONS } from "@/config/mapLayers";
import { getSafetyBand, SAFETY_SCORE_BANDS } from "@/config/safetyWeights";
import type {
  LayerKey,
  LayerVisibility,
  SafetyDataset,
  ScoredRoadSegments,
} from "@/types/safety";

interface LayerPanelProps {
  visibility: LayerVisibility;
  data: SafetyDataset | null;
  error: string | null;
  roadSegments: ScoredRoadSegments | null;
  selectedRoadId: string;
  onRoadSelect: (id: string) => void;
  onToggle: (key: LayerKey) => void;
}

export function LayerPanel({
  visibility,
  data,
  error,
  roadSegments,
  selectedRoadId,
  onRoadSelect,
  onToggle,
}: LayerPanelProps) {
  const featureCounts = new Map<LayerKey, number>();
  const selectedRoad = roadSegments?.features.find(
    (road) => road.properties.id === selectedRoadId,
  );

  data?.features.features.forEach((feature) => {
    const type = feature.properties.type;
    featureCounts.set(type, (featureCounts.get(type) ?? 0) + 1);
  });
  featureCounts.set("risk_zone", data?.riskZones.features.length ?? 0);

  return (
    <aside className="control-panel" aria-label="지도 레이어 설정">
      <header className="panel-header">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p>광주광역시 동구</p>
          <h1>밤길 안심지도</h1>
        </div>
      </header>

      <section className="panel-section layer-section" aria-labelledby="layer-heading">
        <div className="section-heading">
          <h2 id="layer-heading">지도 레이어</h2>
          <span className={error ? "is-error" : ""}>
            {error ? "연결 오류" : data ? "데모 데이터" : "불러오는 중"}
          </span>
        </div>

        {error ? (
          <p className="data-error" role="alert">
            {error} 페이지를 새로고침해 다시 시도해 주세요.
          </p>
        ) : (
          <>
            <div className="layer-list">
              {MAP_LAYER_DEFINITIONS.map((layer) => (
                <label className="layer-row" key={layer.key}>
                  <input
                    type="checkbox"
                    checked={visibility[layer.key]}
                    onChange={() => onToggle(layer.key)}
                  />
                  <span
                    className={`layer-swatch ${layer.kind === "area" ? "is-area" : ""}`}
                    style={{ "--layer-color": layer.color } as React.CSSProperties}
                    aria-hidden="true"
                  />
                  <span className="layer-copy">
                    <strong>{layer.label}</strong>
                    <small>{layer.description}</small>
                  </span>
                  <span className="layer-count">
                    {data ? featureCounts.get(layer.key) ?? 0 : "-"}
                  </span>
                </label>
              ))}
            </div>

            <div className="score-legend" aria-labelledby="legend-heading">
              <h2 id="legend-heading">밤길 안전 참고지수</h2>
              <p>현재 표시된 도로끼리 비교하는 5단계 범례입니다.</p>
              <ul>
                {SAFETY_SCORE_BANDS.map((band) => (
                  <li key={band.label}>
                    <span style={{ background: band.color }} aria-hidden="true" />
                    <strong>{band.label}</strong>
                    <small>
                      {band.min}~{band.max}
                    </small>
                  </li>
                ))}
              </ul>
            </div>

            <div className="road-lookup">
              <label htmlFor="road-score-select">도로별 상세 조회</label>
              <p>지도 클릭이 어려운 경우 도로를 선택해 같은 지표를 확인할 수 있습니다.</p>
              <select
                id="road-score-select"
                value={selectedRoadId}
                onChange={(event) => onRoadSelect(event.target.value)}
                disabled={!roadSegments?.features.length}
              >
                {roadSegments?.features.map((road) => (
                  <option value={road.properties.id} key={road.properties.id}>
                    {road.properties.name}
                  </option>
                ))}
              </select>

              {selectedRoad ? (
                <div className="road-lookup-result" aria-live="polite">
                  <div>
                    <strong>{selectedRoad.properties.safetyScore} / 100</strong>
                    <span>{getSafetyBand(selectedRoad.properties.safetyScore).label}</span>
                  </div>
                  <dl>
                    <div>
                      <dt>보안등</dt>
                      <dd>{selectedRoad.properties.lightingScore}점</dd>
                    </div>
                    <div>
                      <dt>CCTV·비상벨</dt>
                      <dd>{selectedRoad.properties.surveillanceScore}점</dd>
                    </div>
                    <div>
                      <dt>상대적 주의도</dt>
                      <dd>{selectedRoad.properties.crimeScore}점</dd>
                    </div>
                    <div>
                      <dt>주변 환경</dt>
                      <dd>{selectedRoad.properties.environmentScore}점</dd>
                    </div>
                  </dl>
                </div>
              ) : null}
            </div>

            <div className="reference-note">
              <h2>이용 안내</h2>
              <p>
                이 지수는 안심 인프라와 주변 환경 데이터를 조합한 상대적 참고값이며, 특정 장소의
                절대적인 안전을 보장하지 않습니다.
              </p>
            </div>
          </>
        )}
      </section>

      <footer className="panel-footer">
        <span className={`data-status ${error ? "is-error" : ""}`} aria-hidden="true" />
        <p>
          {error ? (
            <strong>데이터 연결 상태를 확인해 주세요.</strong>
          ) : (
            <>
              <strong>
                {data?.metadata.sourceKind === "mock" ? "기능 검증용 mock 데이터" : "공공데이터 실측 자료"}
              </strong>
              · 기준일 {data?.metadata.updatedAt || "확인 중"}
            </>
          )}
        </p>
      </footer>
    </aside>
  );
}
