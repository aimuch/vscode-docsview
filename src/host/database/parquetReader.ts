// Pure TypeScript Apache Parquet binary reader (zero extra npm dependencies).
// Parses PAR1 footer Thrift Compact Protocol metadata, UNCOMPRESSED / SNAPPY / GZIP pages,
// and PLAIN / RLE_DICTIONARY encodings into tabular columns & rows.
import { gunzipSync } from 'fflate';

export interface ParquetTable {
  columns: string[];
  rows: string[][];
  rowCount: number;
  truncated?: boolean;
}

// ---------------------------------------------------------------- Snappy block decompressor

function decompressSnappy(src: Uint8Array): Uint8Array {
  let pos = 0;
  let outLen = 0;
  let shift = 0;
  while (pos < src.length) {
    const b = src[pos++];
    outLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
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
        len = 0;
        for (let i = 0; i < extraBytes; i++) {
          len |= src[pos++] << (i * 8);
        }
        len += 1;
      }
      out.set(src.subarray(pos, pos + len), outPos);
      pos += len;
      outPos += len;
    } else {
      let len: number;
      let offset: number;
      if (type === 1) {
        len = ((tag >>> 2) & 0x07) + 4;
        offset = ((tag & 0xe0) << 3) | src[pos++];
      } else if (type === 2) {
        len = (tag >>> 2) + 1;
        offset = src[pos++] | (src[pos++] << 8);
      } else {
        len = (tag >>> 2) + 1;
        offset =
          src[pos++] |
          (src[pos++] << 8) |
          (src[pos++] << 16) |
          (src[pos++] << 24);
      }
      for (let i = 0; i < len && outPos < outLen; i++) {
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
    return this.buf[this.pos++];
  }

  readVarint(): number {
    let result = 0;
    let factor = 1;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) break;
      factor *= 128;
    }
    return result;
  }

  readZigZag(): number {
    const n = this.readVarint();
    return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
  }

  readBinary(): Uint8Array {
    const len = this.readVarint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
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
        this.readVarint();
        break;
      case 7: // DOUBLE
        this.pos += 8;
        break;
      case 8: // BINARY
        this.pos += this.readVarint();
        break;
      case 9: // LIST
      case 10: {
        // SET
        const { elemType, size } = this.readListHeader();
        for (let i = 0; i < size; i++) this.skip(elemType);
        break;
      }
      case 11: {
        // MAP
        const size = this.readVarint();
        if (size > 0) {
          const kv = this.readByte();
          const kType = (kv >>> 4) & 0x0f;
          const vType = kv & 0x0f;
          for (let i = 0; i < size; i++) {
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
        r.readStruct((sf, st) => {
          if (sf === 1) el.type = r.readZigZag();
          else if (sf === 2) el.typeLength = r.readZigZag();
          else if (sf === 3) el.repetitionType = r.readZigZag();
          else if (sf === 4) el.name = r.readString();
          else if (sf === 5) el.numChildren = r.readZigZag();
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

function decompressPage(raw: Uint8Array, codec: number): Uint8Array {
  if (codec === 0) return raw;
  if (codec === 1) return decompressSnappy(raw);
  if (codec === 2) return gunzipSync(raw);
  throw new Error(`Unsupported Parquet compression codec (${codec}). Supported: UNCOMPRESSED, SNAPPY, GZIP.`);
}

function decodeRleBitPacked(buf: Uint8Array, start: number, bitWidth: number, count: number): { values: number[]; next: number } {
  const values: number[] = [];
  let pos = start;
  const byteWidth = Math.ceil(bitWidth / 8);
  while (values.length < count && pos < buf.length) {
    let header = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      header |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if ((header & 1) === 0) {
      // RLE run
      const runLen = header >>> 1;
      let val = 0;
      for (let i = 0; i < byteWidth && pos < buf.length; i++) {
        val |= buf[pos++] << (i * 8);
      }
      for (let i = 0; i < runLen && values.length < count; i++) {
        values.push(val);
      }
    } else {
      // Bit-packed run (groups of 8)
      const numGroups = header >>> 1;
      const total = numGroups * 8;
      let bitBuf = 0;
      let bitsInBuf = 0;
      const mask = (1 << bitWidth) - 1;
      for (let i = 0; i < total; i++) {
        while (bitsInBuf < bitWidth && pos < buf.length) {
          bitBuf |= buf[pos++] << bitsInBuf;
          bitsInBuf += 8;
        }
        const v = bitBuf & mask;
        bitBuf >>>= bitWidth;
        bitsInBuf -= bitWidth;
        if (values.length < count) values.push(v);
      }
    }
  }
  return { values, next: pos };
}

function decodePlainValues(
  buf: Uint8Array,
  start: number,
  physType: number,
  count: number,
  fixedLen = 0,
): string[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: string[] = [];
  let pos = start;
  const dec = new TextDecoder('utf-8');

  for (let i = 0; i < count && pos < buf.length; i++) {
    switch (physType) {
      case 0: {
        // BOOLEAN (bit-packed)
        const byte = buf[start + (i >> 3)];
        out.push(((byte >> (i & 7)) & 1) ? 'true' : 'false');
        break;
      }
      case 1: // INT32
        out.push(pos + 4 <= buf.length ? String(view.getInt32(pos, true)) : '');
        pos += 4;
        break;
      case 2: // INT64
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
      case 4: // FLOAT
        out.push(pos + 4 <= buf.length ? String(Number(view.getFloat32(pos, true).toPrecision(7))) : '');
        pos += 4;
        break;
      case 5: // DOUBLE
        out.push(pos + 8 <= buf.length ? String(view.getFloat64(pos, true)) : '');
        pos += 8;
        break;
      case 6: {
        // BYTE_ARRAY
        if (pos + 4 > buf.length) {
          out.push('');
          break;
        }
        const len = view.getUint32(pos, true);
        pos += 4;
        out.push(dec.decode(buf.subarray(pos, Math.min(buf.length, pos + len))));
        pos += len;
        break;
      }
      case 7: {
        // FIXED_LEN_BYTE_ARRAY
        const len = Math.max(1, fixedLen);
        out.push(dec.decode(buf.subarray(pos, Math.min(buf.length, pos + len))));
        pos += len;
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
  if (footerStart < 4) {
    throw new Error('Invalid Parquet footer length.');
  }

  const meta = parseFileMetaData(bytes.subarray(footerStart, bytes.length - 8));
  const leafCols = meta.schema.filter((el) => el.type !== undefined);
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
      const isOptional = schemaEl.repetitionType === 1;
      const chunkStart =
        chunk.dictionaryPageOffset !== undefined && chunk.dictionaryPageOffset > 0 && chunk.dictionaryPageOffset < chunk.dataPageOffset
          ? chunk.dictionaryPageOffset
          : chunk.dataPageOffset;
      const chunkEnd = Math.min(bytes.length - 8, chunkStart + chunk.totalCompressedSize);
      const reader = new CompactReader(bytes, chunkStart);
      let dict: string[] | undefined;
      const colVals: string[] = [];

      while (reader.pos < chunkEnd && colVals.length < takeRows) {
        let pageType = 0;
        let compressedSize = 0;
        let numValues = 0;
        let encoding = 0;
        let defLevelByteLen = 0;
        let repLevelByteLen = 0;

        reader.readStruct((pf) => {
          if (pf === 1) pageType = reader.readZigZag();
          else if (pf === 3) compressedSize = reader.readZigZag();
          else if (pf === 5) {
            // DataPageHeader (v1)
            reader.readStruct((df) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 2) encoding = reader.readZigZag();
              else return false;
            });
          } else if (pf === 7) {
            // DictionaryPageHeader
            reader.readStruct((df) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 2) encoding = reader.readZigZag();
              else return false;
            });
          } else if (pf === 8) {
            // DataPageHeaderV2
            reader.readStruct((df) => {
              if (df === 1) numValues = reader.readZigZag();
              else if (df === 4) encoding = reader.readZigZag();
              else if (df === 5) defLevelByteLen = reader.readZigZag();
              else if (df === 6) repLevelByteLen = reader.readZigZag();
              else return false;
            });
          } else {
            return false;
          }
        });

        const rawPage = bytes.subarray(reader.pos, Math.min(bytes.length, reader.pos + compressedSize));
        reader.pos += compressedSize;

        if (pageType === 2) {
          // DICTIONARY_PAGE
          const pageBuf = decompressPage(rawPage, chunk.codec);
          dict = decodePlainValues(pageBuf, 0, chunk.type, numValues, schemaEl.typeLength);
        } else if (pageType === 0 || pageType === 3) {
          // DATA_PAGE (0) or DATA_PAGE_V2 (3)
          let dataBuf: Uint8Array;
          let dataPos = 0;
          let defLevels: number[] | undefined;

          if (pageType === 3) {
            const levelLen = repLevelByteLen + defLevelByteLen;
            if (isOptional && defLevelByteLen > 0) {
              defLevels = decodeRleBitPacked(rawPage, repLevelByteLen, 1, numValues).values;
            }
            dataBuf = decompressPage(rawPage.subarray(levelLen), chunk.codec);
          } else {
            dataBuf = decompressPage(rawPage, chunk.codec);
            if (isOptional && dataBuf.length >= 4) {
              const dlLen = new DataView(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength).getUint32(0, true);
              defLevels = decodeRleBitPacked(dataBuf, 4, 1, numValues).values;
              dataPos = 4 + dlLen;
            }
          }

          const nonNullCount = defLevels ? defLevels.filter((d) => d > 0).length : numValues;
          let decoded: string[];
          if ((encoding === 2 || encoding === 8) && dict) {
            const bitWidth = dataBuf[dataPos++] ?? 0;
            const indices =
              bitWidth === 0
                ? new Array<number>(nonNullCount).fill(0)
                : decodeRleBitPacked(dataBuf, dataPos, bitWidth, nonNullCount).values;
            decoded = indices.map((idx) => dict![idx] ?? '');
          } else {
            decoded = decodePlainValues(dataBuf, dataPos, chunk.type, nonNullCount, schemaEl.typeLength);
          }

          if (defLevels) {
            let dIdx = 0;
            for (let i = 0; i < numValues && colVals.length < takeRows; i++) {
              colVals.push(defLevels[i] > 0 ? (decoded[dIdx++] ?? '') : '');
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
