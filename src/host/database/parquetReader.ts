// Pure TypeScript Apache Parquet binary reader (zero extra npm dependencies).
// Parses PAR1 footer Thrift Compact Protocol metadata, UNCOMPRESSED / SNAPPY / GZIP pages,
// DATA_PAGE v1 & v2 (including is_compressed), schema-tree def/rep levels, PLAIN, RLE & RLE_DICTIONARY.
import { gunzipSync } from 'fflate';

export interface ParquetTable {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncated?: boolean;
}

const MAX_UNCOMPRESSED_PAGE = 64 * 1024 * 1024;

const CODEC_NAMES: Record<number, string> = {
  0: 'UNCOMPRESSED',
  1: 'SNAPPY',
  2: 'GZIP',
  3: 'LZO',
  4: 'BROTLI',
  5: 'LZ4',
  6: 'ZSTD',
  7: 'LZ4_RAW',
};

const ENCODING_NAMES: Record<number, string> = {
  0: 'PLAIN',
  2: 'PLAIN_DICTIONARY',
  3: 'RLE',
  4: 'BIT_PACKED',
  5: 'DELTA_BINARY_PACKED',
  6: 'DELTA_LENGTH_BYTE_ARRAY',
  7: 'DELTA_BYTE_ARRAY',
  8: 'RLE_DICTIONARY',
  9: 'BYTE_STREAM_SPLIT',
};

// ---------------------------------------------------------------- Snappy block decompressor

function decompressSnappy(src: Uint8Array): Uint8Array {
  let pos = 0;
  let outLen = 0;
  let shift = 0;
  while (pos < src.length && shift <= 28) {
    const b = src[pos++];
    outLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (outLen < 0 || outLen > MAX_UNCOMPRESSED_PAGE) {
    throw new Error(`Invalid Snappy uncompressed size (${outLen} bytes).`);
  }
  const out = new Uint8Array(outLen);
  let outPos = 0;

  while (pos < src.length && outPos < outLen) {
    const tag = src[pos++];
    const type = tag & 0x03;
    if (type === 0) {
      let len = (tag >>> 2) + 1;
      if (len > 60) {
        const extraBytes = len - 60;
        if (pos + extraBytes > src.length) throw new Error('Truncated Snappy literal length.');
        len = 0;
        for (let i = 0; i < extraBytes; i++) {
          len |= src[pos++] << (i * 8);
        }
        len = (len >>> 0) + 1;
      }
      if (pos + len > src.length || outPos + len > outLen) {
        throw new Error('Corrupt Snappy literal exceeds buffer bounds.');
      }
      out.set(src.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
    } else {
      let len: number;
      let offset: number;
      if (type === 1) {
        if (pos >= src.length) throw new Error('Truncated Snappy copy-1 offset.');
        len = ((tag >>> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | src[pos++];
      } else if (type === 2) {
        if (pos + 2 > src.length) throw new Error('Truncated Snappy copy-2 offset.');
        len = (tag >>> 2) + 1;
        offset = src[pos++] | (src[pos++] << 8);
      } else {
        if (pos + 4 > src.length) throw new Error('Truncated Snappy copy-4 offset.');
        len = (tag >>> 2) + 1;
        offset = (src[pos++] | (src[pos++] << 8) | (src[pos++] << 16) | (src[pos++] << 24)) >>> 0;
      }
      if (offset === 0 || offset > outPos || outPos + len > outLen) {
        throw new Error('Corrupt Snappy back-reference offset.');
      }
      for (let i = 0; i < len; i++) {
        out[outPos] = out[outPos - offset];
        outPos++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- Thrift Compact Protocol reader

class CompactReader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start;
  }

  readByte(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }

  readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length && shift <= 63n) {
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7n;
    }
    return result;
  }

  readVarint(): number {
    return Number(this.readVarintBig());
  }

  readZigZag(): number {
    const n = this.readVarintBig();
    const signed = (n >> 1n) ^ -(n & 1n);
    return Number(signed);
  }

  readBinary(): Uint8Array {
    const len = Math.max(0, this.readVarint());
    const end = Math.min(this.buf.length, this.pos + len);
    const out = this.buf.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  readString(): string {
    return new TextDecoder('utf-8').decode(this.readBinary());
  }

  readListHeader(): { elemType: number; size: number } {
    const b = this.readByte();
    let size = (b >>> 4) & 0x0f;
    const elemType = b & 0x0f;
    if (size === 15) size = this.readVarint();
    return { elemType, size };
  }

  readStruct(onField: (fieldId: number, type: number) => boolean | void): void {
    let lastFieldId = 0;
    while (this.pos < this.buf.length) {
      const b = this.readByte();
      if (b === 0) break;
      const delta = (b >>> 4) & 0x0f;
      const type = b & 0x0f;
      const fieldId = delta === 0 ? this.readZigZag() : lastFieldId + delta;
      lastFieldId = fieldId;
      const handled = onField(fieldId, type);
      if (handled === false) {
        this.skip(type);
      }
    }
  }

  skip(type: number): void {
    switch (type) {
      case 1: // TRUE
      case 2: // FALSE
        break;
      case 3: // BYTE
        this.pos += 1;
        break;
      case 4: // I16
      case 5: // I32
      case 6: // I64
        this.readVarintBig();
        break;
      case 7: // DOUBLE
        this.pos += 8;
        break;
      case 8: // BINARY
        this.pos += Math.max(0, this.readVarint());
        break;
      case 9: // LIST
      case 10: {
        const { elemType, size } = this.readListHeader();
        for (let i = 0; i < size && this.pos < this.buf.length; i++) this.skip(elemType);
        break;
      }
      case 11: {
        const size = this.readVarint();
        if (size > 0) {
          const kv = this.readByte();
          const kType = (kv >>> 4) & 0x0f;
          const vType = kv & 0x0f;
          for (let i = 0; i < size && this.pos < this.buf.length; i++) {
            this.skip(kType);
            this.skip(vType);
          }
        }
        break;
      }
      case 12: // STRUCT
        this.readStruct(() => false);
        break;
      default:
        break;
    }
  }
}

interface SchemaElement {
  name: string;
  type?: number;
  typeLength?: number;
  repetitionType?: number;
  numChildren?: number;
  convertedType?: number;
}

interface LeafColumnInfo {
  name: string;
  type: number;
  typeLength?: number;
  convertedType?: number;
  maxDefLevel: number;
  maxRepLevel: number;
}

interface ColumnChunkMeta {
  type: number;
  codec: number;
  numValues: number;
  dataPageOffset: number;
  dictionaryPageOffset?: number;
  totalCompressedSize: number;
}

interface RowGroupMeta {
  numRows: number;
  columns: ColumnChunkMeta[];
}

function parseFileMetaData(buf: Uint8Array): { schema: SchemaElement[]; rowGroups: RowGroupMeta[]; numRows: number } {
  const r = new CompactReader(buf);
  const schema: SchemaElement[] = [];
  const rowGroups: RowGroupMeta[] = [];
  let numRows = 0;

  r.readStruct((fid, type) => {
    if (fid === 2 && type === 9) {
      const { size } = r.readListHeader();
      for (let i = 0; i < size; i++) {
        const el: SchemaElement = { name: '' };
        r.readStruct((sf) => {
          if (sf === 1) el.type = r.readZigZag();
          else if (sf === 2) el.typeLength = r.readZigZag();
          else if (sf === 3) el.repetitionType = r.readZigZag();
          else if (sf === 4) el.name = r.readString();
          else if (sf === 5) el.numChildren = r.readZigZag();
          else if (sf === 6) el.convertedType = r.readZigZag();
          else return false;
        });
        schema.push(el);
      }
    } else if (fid === 3) {
      numRows = r.readZigZag();
    } else if (fid === 4 && type === 9) {
      const { size } = r.readListHeader();
      for (let i = 0; i < size; i++) {
        const rg: RowGroupMeta = { numRows: 0, columns: [] };
        r.readStruct((rf, rt) => {
          if (rf === 1 && rt === 9) {
            const { size: colCount } = r.readListHeader();
            for (let c = 0; c < colCount; c++) {
              const cc: ColumnChunkMeta = {
                type: 6,
                codec: 0,
                numValues: 0,
                dataPageOffset: 0,
                totalCompressedSize: 0,
              };
              r.readStruct((cf) => {
                if (cf === 3) {
                  r.readStruct((mf) => {
                    if (mf === 1) cc.type = r.readZigZag();
                    else if (mf === 4) cc.codec = r.readZigZag();
                    else if (mf === 5) cc.numValues = r.readZigZag();
                    else if (mf === 7) cc.totalCompressedSize = r.readZigZag();
                    else if (mf === 9) cc.dataPageOffset = r.readZigZag();
                    else if (mf === 11) cc.dictionaryPageOffset = r.readZigZag();
                    else return false;
                  });
                } else {
                  return false;
                }
              });
              rg.columns.push(cc);
            }
          } else if (rf === 3) {
            rg.numRows = r.readZigZag();
          } else {
            return false;
          }
        });
        rowGroups.push(rg);
      }
    } else {
      return false;
    }
  });

  return { schema, rowGroups, numRows };
}

function resolveLeafColumns(schema: readonly SchemaElement[]): LeafColumnInfo[] {
  const leaves: LeafColumnInfo[] = [];
  let idx = 0;
  const walk = (prefix: string, defLevel: number, repLevel: number, remaining: number) => {
    for (let i = 0; i < remaining && idx < schema.length; i++) {
      const el = schema[idx++];
      const nextDef = defLevel + (el.repetitionType === 1 || el.repetitionType === 2 ? 1 : 0);
      const nextRep = repLevel + (el.repetitionType === 2 ? 1 : 0);
      const fullName = prefix ? `${prefix}.${el.name}` : el.name;
      if (el.type !== undefined) {
        leaves.push({
          name: fullName,
          type: el.type,
          typeLength: el.typeLength,
          convertedType: el.convertedType,
          maxDefLevel: nextDef,
          maxRepLevel: nextRep,
        });
      } else if (el.numChildren && el.numChildren > 0) {
        walk(fullName, nextDef, nextRep, el.numChildren);
      }
    }
  };
  if (schema.length > 0 && schema[0].numChildren) {
    const rootChildren = schema[0].numChildren;
    idx = 1;
    walk('', 0, 0, rootChildren);
  } else {
    walk('', 0, 0, schema.length);
  }
  return leaves;
}

function bitWidthForMax(maxVal: number): number {
  if (maxVal <= 0) return 0;
  return 32 - Math.clz32(maxVal);
}

function decompressPage(raw: Uint8Array, codec: number): Uint8Array {
  if (codec === 0) return raw;
  if (codec === 1) return decompressSnappy(raw);
  if (codec === 2) return gunzipSync(raw);
  const name = CODEC_NAMES[codec] ?? `codec #${codec}`;
  throw new Error(`Unsupported Parquet compression codec: ${name}. Supported: UNCOMPRESSED, SNAPPY, GZIP.`);
}

function decodeRleBitPacked(
  buf: Uint8Array,
  start: number,
  bitWidth: number,
  count: number,
): { values: number[]; next: number } {
  const values: number[] = [];
  let pos = start;
  if (bitWidth === 0) {
    return { values: new Array<number>(count).fill(0), next: pos };
  }
  const byteWidth = Math.ceil(bitWidth / 8);
  const bwBig = BigInt(bitWidth);
  const maskBig = (1n << bwBig) - 1n;

  while (values.length < count && pos < buf.length) {
    const prevPos = pos;
    let header = 0;
    let shift = 0;
    while (pos < buf.length && shift <= 28) {
      const b = buf[pos++];
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if ((header & 1) === 0) {
      const runLen = header >>> 1;
      let val = 0n;
      for (let i = 0; i < byteWidth && pos < buf.length; i++) {
        val |= BigInt(buf[pos++]) << BigInt(i * 8);
      }
      const numVal = Number(val);
      for (let i = 0; i < runLen && values.length < count; i++) {
        values.push(numVal);
      }
    } else {
      const numGroups = header >>> 1;
      const total = numGroups * 8;
      let bitBuf = 0n;
      let bitsInBuf = 0n;
      for (let i = 0; i < total; i++) {
        while (bitsInBuf < bwBig && pos < buf.length) {
          bitBuf |= BigInt(buf[pos++]) << bitsInBuf;
          bitsInBuf += 8n;
        }
        const v = Number(bitBuf & maskBig);
        bitBuf >>= bwBig;
        bitsInBuf -= bwBig;
        if (values.length < count) values.push(v);
      }
    }
    if (pos <= prevPos) break;
  }
  return { values, next: pos };
}

function decodeByteArraySafe(slice: Uint8Array, convertedType?: number): string {
  if (convertedType === 0 || convertedType === 19 || convertedType === 20) {
    return new TextDecoder('utf-8').decode(slice);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(slice);
  } catch {
    return `<BIN ${slice.length} B>`;
  }
}

function decodeInt96Timestamp(view: DataView, pos: number): string {
  // Legacy Hive/Spark INT96: 8-byte nanos of day (LE) + 4-byte Julian day number (LE)
  const nanos = view.getBigUint64(pos, true);
  const julianDay = view.getUint32(pos + 8, true);
  const unixDays = julianDay - 2440588;
  const ms = unixDays * 86_400_000 + Number(nanos / 1_000_000n);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? `${julianDay}:${nanos}` : d.toISOString();
}

function decodePlainValues(
  buf: Uint8Array,
  start: number,
  physType: number,
  count: number,
  fixedLen = 0,
  convertedType?: number,
): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: string[] = [];
  let pos = start;

  for (let i = 0; i < count && pos < buf.length; i++) {
    switch (physType) {
      case 0: {
        const byteIdx = start + (i >> 3);
        if (byteIdx >= buf.length) {
          out.push('');
          break;
        }
        out.push(((buf[byteIdx] >> (i & 7)) & 1) ? 'true' : 'false');
        break;
      }
      case 1:
        out.push(pos + 4 <= buf.length ? String(view.getInt32(pos, true)) : '');
        pos += 4;
        break;
      case 2:
        if (pos + 8 <= buf.length) {
          try {
            out.push(view.getBigInt64(pos, true).toString());
          } catch {
            out.push(String(view.getInt32(pos, true)));
          }
        } else {
          out.push('');
        }
        pos += 8;
        break;
      case 3: // INT96
        out.push(pos + 12 <= buf.length ? decodeInt96Timestamp(view, pos) : '');
        pos += 12;
        break;
      case 4:
        out.push(pos + 4 <= buf.length ? String(Number(view.getFloat32(pos, true).toPrecision(7))) : '');
        pos += 4;
        break;
      case 5:
        out.push(pos + 8 <= buf.length ? String(view.getFloat64(pos, true)) : '');
        pos += 8;
        break;
      case 6: {
        if (pos + 4 > buf.length) {
          out.push('');
          break;
        }
        const len = view.getUint32(pos, true);
        pos += 4;
        const end = Math.min(buf.length, pos + len);
        out.push(decodeByteArraySafe(buf.subarray(pos, end), convertedType));
        pos = end;
        break;
      }
      case 7: {
        const len = Math.max(1, fixedLen);
        const end = Math.min(buf.length, pos + len);
        out.push(decodeByteArraySafe(buf.subarray(pos, end), convertedType));
        pos = end;
        break;
      }
      default:
        out.push('');
        break;
    }
  }
  return out;
}

/** Reads an Apache Parquet (`PAR1`) byte buffer into columns and rows. */
export function readParquetFile(bytes: Uint8Array, maxRows = 50_000): ParquetTable {
  if (bytes.length < 12) {
    throw new Error('Not a valid Parquet file (too short).');
  }
  const headMagic = new TextDecoder('ascii').decode(bytes.subarray(0, 4));
  const tailMagic = new TextDecoder('ascii').decode(bytes.subarray(bytes.length - 4));
  if (headMagic !== 'PAR1' || tailMagic !== 'PAR1') {
    throw new Error('Not a valid Parquet file (missing PAR1 magic).');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const footerLen = view.getUint32(bytes.length - 8, true);
  const footerStart = bytes.length - 8 - footerLen;
  if (footerStart < 4 || footerLen === 0) {
    throw new Error('Invalid Parquet footer length.');
  }

  const meta = parseFileMetaData(bytes.subarray(footerStart, bytes.length - 8));
  const leafCols = resolveLeafColumns(meta.schema);
  const columns = leafCols.map((el) => el.name);
  const rows: string[][] = [];
  let truncated = false;

  for (const rg of meta.rowGroups) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const takeRows = Math.min(rg.numRows, maxRows - rows.length);
    const colArrays: string[][] = [];

    for (let c = 0; c < leafCols.length; c++) {
      const schemaEl = leafCols[c];
      const chunk = rg.columns[c];
      if (!chunk) {
        colArrays.push(new Array<string>(takeRows).fill(''));
        continue;
      }
      if (schemaEl.maxRepLevel > 0) {
        colArrays.push(new Array<string>(takeRows).fill('<nested list>'));
        continue;
      }
      const defBitWidth = bitWidthForMax(schemaEl.maxDefLevel);
      const chunkStart =
        chunk.dictionaryPageOffset !== undefined &&
        chunk.dictionaryPageOffset > 0 &&
        chunk.dictionaryPageOffset < chunk.dataPageOffset
          ? chunk.dictionaryPageOffset
          : chunk.dataPageOffset;
      const chunkEnd = Math.min(bytes.length - 8, chunkStart + chunk.totalCompressedSize);
      const reader = new CompactReader(bytes, chunkStart);
      let dict: string[] | undefined;
      const colVals: string[] = [];

      while (reader.pos < chunkEnd && colVals.length < takeRows) {
        const prevPos = reader.pos;
        let pageType = 0;
        let compressedSize = 0;
        let numValues = 0;
        let encoding = 0;
        let defLevelByteLen = 0;
        let repLevelByteLen = 0;
        let isCompressed = true;

        reader.readStruct((pf) => {
          if (pf === 1) pageType = reader.readZigZag();
          else if (pf === 3) compressedSize = reader.readZigZag();
          else if (pf === 5) {
            reader.readStruct((df) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 2) encoding = reader.readZigZag();
              else return false;
            });
          } else if (pf === 7) {
            reader.readStruct((df) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 2) encoding = reader.readZigZag();
              else return false;
            });
          } else if (pf === 8) {
            reader.readStruct((df, dt) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 4) encoding = reader.readZigZag();
              else if (df === 5) defLevelByteLen = reader.readZigZag();
              else if (df === 6) repLevelByteLen = reader.readZigZag();
              else if (df === 7) isCompressed = dt === 1;
              else return false;
            });
          } else {
            return false;
          }
        });

        if (compressedSize < 0 || reader.pos + compressedSize > bytes.length) {
          throw new Error('Corrupt Parquet page size.');
        }
        const rawPage = bytes.subarray(reader.pos, reader.pos + compressedSize);
        reader.pos += compressedSize;
        if (reader.pos <= prevPos) break;

        if (pageType === 2) {
          const pageBuf = decompressPage(rawPage, chunk.codec);
          dict = decodePlainValues(pageBuf, 0, chunk.type, numValues, schemaEl.typeLength, schemaEl.convertedType);
        } else if (pageType === 0 || pageType === 3) {
          let dataBuf: Uint8Array;
          let dataPos = 0;
          let defLevels: number[] | undefined;

          if (pageType === 3) {
            const levelLen = repLevelByteLen + defLevelByteLen;
            if (schemaEl.maxDefLevel > 0 && defLevelByteLen > 0) {
              defLevels = decodeRleBitPacked(rawPage, repLevelByteLen, defBitWidth, numValues).values;
            }
            const payloadSlice = rawPage.subarray(levelLen);
            dataBuf = isCompressed ? decompressPage(payloadSlice, chunk.codec) : payloadSlice;
          } else {
            dataBuf = decompressPage(rawPage, chunk.codec);
            if (schemaEl.maxDefLevel > 0 && dataBuf.length >= 4) {
              const dlLen = new DataView(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength).getUint32(0, true);
              defLevels = decodeRleBitPacked(dataBuf, 4, defBitWidth, numValues).values;
              dataPos = 4 + dlLen;
            }
          }

          const nonNullCount = defLevels
            ? defLevels.filter((d) => d === schemaEl.maxDefLevel).length
            : numValues;
          let decoded: string[];
          if ((encoding === 2 || encoding === 8) && dict) {
            const bitWidth = dataBuf[dataPos++] ?? 0;
            const indices = decodeRleBitPacked(dataBuf, dataPos, bitWidth, nonNullCount).values;
            decoded = indices.map((idx) => dict![idx] ?? '');
          } else if (encoding === 3 && chunk.type === 0) {
            // RLE-encoded BOOLEAN
            const byteLen =
              dataPos + 4 <= dataBuf.length
                ? new DataView(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength).getUint32(dataPos, true)
                : 0;
            const bools = decodeRleBitPacked(dataBuf.subarray(dataPos + 4, dataPos + 4 + byteLen), 0, 1, nonNullCount).values;
            decoded = bools.map((v) => (v ? 'true' : 'false'));
          } else if (encoding === 0) {
            decoded = decodePlainValues(
              dataBuf,
              dataPos,
              chunk.type,
              nonNullCount,
              schemaEl.typeLength,
              schemaEl.convertedType,
            );
          } else {
            const encName = ENCODING_NAMES[encoding] ?? `encoding #${encoding}`;
            throw new Error(`Unsupported Parquet page encoding: ${encName}.`);
          }

          if (defLevels) {
            let dIdx = 0;
            for (let i = 0; i < numValues && colVals.length < takeRows; i++) {
              colVals.push(defLevels[i] === schemaEl.maxDefLevel ? (decoded[dIdx++] ?? '') : '');
            }
          } else {
            for (let i = 0; i < decoded.length && colVals.length < takeRows; i++) {
              colVals.push(decoded[i]);
            }
          }
        }
      }

      while (colVals.length < takeRows) colVals.push('');
      colArrays.push(colVals);
    }

    for (let r = 0; r < takeRows; r++) {
      rows.push(colArrays.map((col) => col[r] ?? ''));
    }
  }

  return {
    columns,
    rows,
    rowCount: meta.numRows || rows.length,
    truncated: truncated || meta.numRows > rows.length,
  };
}
