import { useMemo, useState } from "react";
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
  const [roadQuery, setRoadQuery] = useState("");
  const [roadPage, setRoadPage] = useState(0);
  const pageSize = 100;
  const matchingRoads = useMemo(() => {
    const query = roadQuery.trim().toLocaleLowerCase();
    return (roadSegments?.features ?? []).filter((road) =>
      `${road.properties.adminDong ?? ""} ${road.properties.name} ${road.properties.id}`
        .toLocaleLowerCase().includes(query));
  }, [roadSegments, roadQuery]);
  const pageCount = Math.max(1, Math.ceil(matchingRoads.length / pageSize));
  const page = Math.min(roadPage, pageCount - 1);
  const visibleRoads = matchingRoads.slice(page * pageSize, (page + 1) * pageSize);
  const featureCounts = new Map<LayerKey, number>();
  const selectedRoad = roadSegments?.features.find(
    (road) => road.properties.id === selectedRoadId,
  );

  data?.features.features.forEach((feature) => {
    const type = feature.properties.type === "police_center"
      ? "police_station" : feature.properties.type;
    featureCounts.set(type, (featureCounts.get(type) ?? 0) + 1);
  });

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
            {error ? "연결 오류" : data ? "공공데이터" : "불러오는 중"}
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
              <label htmlFor="road-query">도로 검색</label>
              <input
                id="road-query"
                type="search"
                value={roadQuery}
                placeholder="행정동·도로명·구간 ID"
                onChange={(event) => { setRoadQuery(event.target.value); setRoadPage(0); }}
                aria-describedby="road-query-status"
                disabled={!roadSegments}
              />
              <p id="road-query-status" role="status">
                {roadSegments
                  ? `${matchingRoads.length.toLocaleString("ko-KR")}개 구간 · ${page + 1}/${pageCount}쪽`
                  : "도로를 불러오는 중입니다."}
              </p>
              <label htmlFor="road-score-select">도로별 상세 조회</label>
              <p>한 번에 100개씩 표시합니다. 도로명이 없는 구간은 행정동과 식별자로 표시합니다.</p>
              <select
                id="road-score-select"
                value={selectedRoadId}
                onChange={(event) => onRoadSelect(event.target.value)}
                disabled={!roadSegments?.features.length}
              >
                {selectedRoad && !visibleRoads.some((road) => road.properties.id === selectedRoadId) ? (
                  <option value={selectedRoadId}>현재 선택: {selectedRoad.properties.name} · {selectedRoad.properties.id.slice(-8)}</option>
                ) : null}
                {visibleRoads.map((road) => (
                  <option value={road.properties.id} key={road.properties.id}>
                    {road.properties.name}{road.properties.roadNameSource
                      ? ` · ${road.properties.adminDong ?? "동구"} · ${road.properties.id.slice(-8)}` : ""}
                  </option>
                ))}
              </select>
              <div className="road-pagination" aria-label="도로 목록 페이지">
                <button type="button" disabled={page === 0} onClick={() => setRoadPage(page - 1)}>이전</button>
                <button type="button" disabled={page + 1 >= pageCount} onClick={() => setRoadPage(page + 1)}>다음</button>
              </div>
              {roadSegments && !matchingRoads.length ? <p>검색 결과가 없습니다. 행정동이나 구간 ID를 확인해 주세요.</p> : null}

              {selectedRoad ? (
                (() => {
                  const p = selectedRoad.properties;
                  const v2 = p.safetyScoreV2;
                  const dimension = (label: string, value: number | null, nullText = "데이터 없음") => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{value === null ? nullText : `${value}점`}</dd>
                    </div>
                  );
                  return (
                    <div className="road-lookup-result" aria-live="polite">
                      <p>{p.name} · {p.lengthMeters}m · 구간 {p.id}</p>
                      <div>
                        <strong>{v2 === null ? "데이터 없음" : `${v2} / 100`}</strong>
                        <span>{v2 === null ? "" : getSafetyBand(v2).label}</span>
                      </div>
                      <dl>
                        {dimension("조명·가시성", p.lightingScore)}
                        {dimension("감시·긴급대응", p.surveillanceScore)}
                        {dimension("야간활동·자연감시", p.activityScore)}
                        {dimension("폭원·도로 종류 proxy", p.roadActivityScore ?? null)}
                        {dimension("공간환경·방치도", p.environmentScore)}
                        {dimension("여성밤길 치안안전", p.crimeScore, "미수집")}
                        {dimension("기존 지수(v1)", p.safetyScore)}
                        <div>
                          <dt>계획상 도로 종류</dt>
                          <dd>{p.planningRoadGrade
                            ? `${p.planningRoadName ?? p.planningRoadGrade} · ${p.planningRoadStatus ?? "미확인"}${p.planningRoadStatus === "집행완료" ? " (proxy 반영)" : " (점수 미반영)"}`
                            : "확인 불가"}</dd>
                        </div>
                        <div>
                          <dt>보안등</dt>
                          <dd>{p.streetlightCount}개 · 커버리지 {p.lightingCoverage}%</dd>
                        </div>
                        <div>
                          <dt>최대 암구간</dt>
                          <dd>{p.maxDarkGapMeters}m</dd>
                        </div>
                      </dl>
                    </div>
                  );
                })()
              ) : null}
            </div>

            <div className="reference-note">
              <h2>이용 안내</h2>
              <p>
                이 지수는 안심 인프라와 주변 환경 데이터를 조합한 상대적 참고값이며, 특정 장소의
                절대적인 안전을 보장하지 않습니다.
              </p>
              <p>도로 중심선 기반이며 인도 인접 여부는 도형 기반 참고값으로 보행 가능 여부를 판정하지 않습니다. 계획상 도로 종류는 실제 통행량이 아니며, 단일 지정·집행완료가 확인된 구간에서만 폭원 proxy에 일부 반영합니다. 조명 환경은 실제 조도(lux)가 아니라 보안등 위치와 거리 분포를 기반으로 계산한 상대적 추정값입니다. 여성밤길 치안안전은 생활안전지도의 경찰청 범죄 밀도분석(밤 시간대 20~24시) 구간 정보를 우선하고, 여성밤길 데이터가 없는 구간은 범죄주의구간(전체 시간대) 밀도분석으로 보완했습니다. 실제 범죄 발생 가능성을 예측하는 수치가 아닙니다. 시설 접근성은 좌표 거리 기반 참고값이며 경찰시설 거리가 실제 출동시간을 의미하지 않습니다. CPTED는 완료된 환경개선 사업지의 주소를 VWORLD로 좌표화한 대표점이며, 개별 시설 위치나 사업구역 경계가 아닙니다. 야간활동·빈집 등 일부 지표는 좌표 데이터가 수집되지 않아 "데이터 없음"으로 표시됩니다. 주의구간 원본 좌표·노후건물은 미수집입니다.</p>
              <p><a href="/data/roads-meta.json" target="_blank" rel="noreferrer">도로 출처·가공 정보</a> · <a href="/data/sidewalks-meta.json" target="_blank" rel="noreferrer">인도 출처·가공 정보</a> · 국토지리정보원<br />도로명·도시계획 도로: VWorld / <a href="/data/vworld-roads-meta.json" target="_blank" rel="noreferrer">매칭·수집 정보</a><br />주의구간: <a href="https://www.safemap.go.kr" target="_blank" rel="noreferrer">행정안전부 생활안전지도</a> / 경찰청<br />CPTED: 생활안전지도 · VWORLD / <a href="/data/cpted-meta.json" target="_blank" rel="noreferrer">수집·지오코딩 정보</a><br />경계: SGIS / vuski·admdongkor (CC BY 4.0)</p>
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
