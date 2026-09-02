import { describe, expect, it } from 'vitest';
import { ArcFlag, NodeFlag, decodeGraphTile, encodeGraphTile, graphTileBounds, lonLatToGraphTile, packGraphTile, unpackGraphTile } from './graph-format';

// A three-node path A—B—C where B—C has one intermediate shape point; C is foreign.
const sample = {
  tx: 1205, ty: 1539,
  nodeId: [1e10 + 1, 1e10 + 2, 1e10 + 3],
  nodeLon: [-739568000, -739560000, -739550000],
  nodeLat: [407176000, 407180000, 407190000],
  nodeFlags: [0, 0, NodeFlag.FOREIGN],
  arcStart: [0, 1, 3, 3],
  arcTo: [1, 0, 2],
  arcLen: [80, 80, 140],
  arcFlags: [ArcFlag.WALK | ArcFlag.BIKE, ArcFlag.WALK | ArcFlag.BIKE | ArcFlag.REVERSED, ArcFlag.WALK | ArcFlag.DRIVE],
  arcWay: [5001, 5001, 5002],
  arcShapeStart: [0, 0, 0],
  arcShapeEnd: [0, 0, 1],
  shapeLon: [-739555000],
  shapeLat: [407185000],
};

describe('graph tile format', () => {
  it('round-trips through encode/decode', () => {
    const raw = encodeGraphTile(sample);
    const t = decodeGraphTile(raw);
    expect(t.tx).toBe(1205); expect(t.ty).toBe(1539); expect(t.zoom).toBe(12);
    expect(Array.from(t.nodeId)).toEqual(sample.nodeId);
    expect(Array.from(t.nodeLon)).toEqual(sample.nodeLon);
    expect(Array.from(t.nodeFlags)).toEqual(sample.nodeFlags);
    expect(Array.from(t.arcStart)).toEqual(sample.arcStart);
    expect(Array.from(t.arcTo)).toEqual(sample.arcTo);
    expect(Array.from(t.arcLen)).toEqual(sample.arcLen);
    expect(Array.from(t.arcFlags)).toEqual(sample.arcFlags);
    expect(Array.from(t.arcWay)).toEqual(sample.arcWay);
    expect(Array.from(t.arcShapeEnd)).toEqual(sample.arcShapeEnd);
    expect(Array.from(t.shapeLat)).toEqual(sample.shapeLat);
  });

  it('round-trips through the deflated on-disk form and survives unaligned input', () => {
    const packed = packGraphTile(sample);
    const padded = new Uint8Array(packed.length + 3);
    padded.set(packed, 3);
    const t = unpackGraphTile(padded.subarray(3));
    expect(Array.from(t.nodeId)).toEqual(sample.nodeId);
    expect(t.arcTo[2]).toBe(2);
  });

  it('rejects foreign bytes and truncated tiles', () => {
    expect(() => decodeGraphTile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/UFG1/);
    const raw = encodeGraphTile(sample);
    expect(() => decodeGraphTile(raw.subarray(0, raw.length - 8))).toThrow(/size mismatch/);
  });

  it('maps lon/lat to zoom-12 tiles consistently with tile bounds', () => {
    const [tx, ty] = lonLatToGraphTile(-73.9568, 40.7176);
    const b = graphTileBounds(tx, ty);
    expect(b.west).toBeLessThanOrEqual(-73.9568); expect(b.east).toBeGreaterThan(-73.9568);
    expect(b.south).toBeLessThanOrEqual(40.7176); expect(b.north).toBeGreaterThan(40.7176);
    expect([tx, ty]).toEqual([1206, 1539]);
  });
});
