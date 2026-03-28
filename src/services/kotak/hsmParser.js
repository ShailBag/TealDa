'use strict';

const pako = require('pako');

const BinRespTypes = { CONNECTION_TYPE: 1, DATA_TYPE: 6, SUBSCRIBE_TYPE: 4 };
const BinRespStat = { OK: 'K', NOT_OK: 'N' };
const ResponseTypes = { SNAP: 83, UPDATE: 85 };
const STRING_INDEX = { NAME: 51, SYMBOL: 52, EXCHG: 53, TSYMBOL: 54 };
const INDEX_INDEX = { LTP: 2, CLOSE: 3, CHANGE: 10, PERCHANGE: 11, MULTIPLIER: 8, PRECISION: 9 };
const SCRIP_INDEX = { LTP: 5, CLOSE: 21, VOLUME: 4, MULTIPLIER: 23, PRECISION: 24 };
const TopicTypes = { SCRIP: 'sf', INDEX: 'if', DEPTH: 'dp' };

function buf2Long(buf) {
  const b = Buffer.isBuffer(buf) ? new Uint8Array(buf) : new Uint8Array(buf);
  let val = 0;
  for (let i = 0, j = b.length - 1; i < b.length; i++, j--) {
    val += b[j] << (i * 8);
  }
  return val;
}

function buf2String(buf) {
  const b = Buffer.isBuffer(buf) ? new Uint8Array(buf) : new Uint8Array(buf);
  return String.fromCharCode.apply(null, b);
}

function decodeData(base64Str) {
  const decoded = Buffer.from(base64Str, 'base64');
  const inflated = pako.inflate(new Uint8Array(decoded));
  return Buffer.from(inflated);
}

function leadingZero(a) {
  return a < 10 ? '0' + a : String(a);
}

function getFormatDate(ts) {
  const d = new Date(ts * 1000);
  return leadingZero(d.getDate()) + '/' + leadingZero(d.getMonth() + 1) + '/' + d.getFullYear() +
    ' ' + leadingZero(d.getHours()) + ':' + leadingZero(d.getMinutes()) + ':' + leadingZero(d.getSeconds());
}

let ackNum = 0;
const topicList = {};
let counter = 0;

function IndexTopicData(topicName) {
  this.topicName = topicName || '';
  this.feedType = TopicTypes.INDEX;
  this.fieldDataArray = [];
  this.updatedFieldsArray = [];
  this.multiplier = 1;
  this.precision = 2;
  this.precisionValue = 100;
  this.setLongValues = function (idx, val) {
    if (this.fieldDataArray[idx] !== val && val !== -2147483648) {
      this.fieldDataArray[idx] = val;
      this.updatedFieldsArray[idx] = true;
    }
  };
  this.setStringValues = function (fid, str) {
    if (fid === STRING_INDEX.SYMBOL) this.fieldDataArray[STRING_INDEX.SYMBOL] = str;
    else if (fid === STRING_INDEX.EXCHG) this.fieldDataArray[STRING_INDEX.EXCHG] = str;
    else if (fid === STRING_INDEX.TSYMBOL) this.fieldDataArray[STRING_INDEX.TSYMBOL] = str;
    this.updatedFieldsArray[fid] = true;
  };
  this.setMultiplierAndPrec = function () {
    if (this.updatedFieldsArray[INDEX_INDEX.PRECISION]) {
      this.precision = this.fieldDataArray[INDEX_INDEX.PRECISION];
      this.precisionValue = Math.pow(10, this.precision);
    }
    if (this.updatedFieldsArray[INDEX_INDEX.MULTIPLIER]) {
      this.multiplier = this.fieldDataArray[INDEX_INDEX.MULTIPLIER];
    }
  };
  this.prepareData = function () {
    this.updatedFieldsArray[STRING_INDEX.NAME] = true;
    this.updatedFieldsArray[STRING_INDEX.EXCHG] = true;
    this.updatedFieldsArray[STRING_INDEX.SYMBOL] = true;
    if (this.updatedFieldsArray[INDEX_INDEX.LTP] || this.updatedFieldsArray[INDEX_INDEX.CLOSE]) {
      const ltp = this.fieldDataArray[INDEX_INDEX.LTP];
      const close = this.fieldDataArray[INDEX_INDEX.CLOSE];
      if (ltp != null && close != null) {
        this.fieldDataArray[INDEX_INDEX.CHANGE] = ltp - close;
        this.updatedFieldsArray[INDEX_INDEX.CHANGE] = true;
        this.fieldDataArray[INDEX_INDEX.PERCHANGE] = ((ltp - close) / close * 100).toFixed(this.precision);
        this.updatedFieldsArray[INDEX_INDEX.PERCHANGE] = true;
      }
    }
    const jsonRes = {};
    if (this.topicName) jsonRes.topicName = this.topicName;
    const names = ['ftm0', 'dtm1', 'iv', 'ic', 'tvalue', 'highPrice', 'lowPrice', 'openingPrice', 'mul', 'prec', 'cng', 'nc', 'name', 'tk', 'e', 'ts'];
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 51, 52, 53, 54];
    for (let i = 0; i < indices.length; i++) {
      const idx = indices[i];
      const val = this.fieldDataArray[idx];
      if (this.updatedFieldsArray[idx] && val !== undefined) {
        if ([2, 3, 5, 6, 7, 10].indexOf(idx) >= 0) {
          jsonRes[names[i]] = (val / (this.multiplier * this.precisionValue)).toFixed(this.precision);
        } else if ([0, 1, 4].indexOf(idx) >= 0) {
          jsonRes[names[i]] = getFormatDate(val);
        } else {
          jsonRes[names[i]] = String(val);
        }
      }
    }
    this.updatedFieldsArray = [];
    return jsonRes;
  };
}

function ScripTopicData(topicName) {
  this.feedType = TopicTypes.SCRIP;
  this.topicName = topicName;
  this.fieldDataArray = [];
  this.updatedFieldsArray = [];
  this.multiplier = 1;
  this.precision = 2;
  this.precisionValue = 100;
  this.setLongValues = function (idx, val) {
    if (this.fieldDataArray[idx] !== val && val !== -2147483648) {
      this.fieldDataArray[idx] = val;
      this.updatedFieldsArray[idx] = true;
    }
  };
  this.setStringValues = function (fid, str) {
    if (fid === STRING_INDEX.SYMBOL) this.fieldDataArray[STRING_INDEX.SYMBOL] = str;
    else if (fid === STRING_INDEX.EXCHG) this.fieldDataArray[STRING_INDEX.EXCHG] = str;
    else if (fid === STRING_INDEX.TSYMBOL) this.fieldDataArray[STRING_INDEX.TSYMBOL] = str;
    this.updatedFieldsArray[fid] = true;
  };
  this.setMultiplierAndPrec = function () {
    if (this.updatedFieldsArray[SCRIP_INDEX.PRECISION]) {
      this.precision = this.fieldDataArray[SCRIP_INDEX.PRECISION];
      this.precisionValue = Math.pow(10, this.precision);
    }
    if (this.updatedFieldsArray[SCRIP_INDEX.MULTIPLIER]) {
      this.multiplier = this.fieldDataArray[SCRIP_INDEX.MULTIPLIER];
    }
    if (!this.multiplier || this.multiplier === 0) this.multiplier = 1;
    if (!this.precisionValue || this.precisionValue === 0) this.precisionValue = 100;
  };
  this.prepareData = function () {
    const mul = this.multiplier && this.multiplier !== 0 ? this.multiplier : 1;
    const precVal = this.precisionValue && this.precisionValue !== 0 ? this.precisionValue : 100;
    const divisor = mul * precVal;
    const ltpRaw = this.fieldDataArray[SCRIP_INDEX.LTP];
    const volRaw = this.fieldDataArray[SCRIP_INDEX.VOLUME];
    const ltp = (ltpRaw != null && ltpRaw !== -2147483648 && ltpRaw > 0)
      ? (ltpRaw / divisor).toFixed(this.precision)
      : null;
    this.updatedFieldsArray = [];
    const out = {
      ltp: ltp != null ? String(ltp) : null,
      V: (volRaw != null && volRaw !== -2147483648) ? String(volRaw) : null,
      topicName: this.topicName,
      name: TopicTypes.SCRIP,
      tk: this.fieldDataArray[STRING_INDEX.SYMBOL] != null ? String(this.fieldDataArray[STRING_INDEX.SYMBOL]) : null,
      e: this.fieldDataArray[STRING_INDEX.EXCHG] != null ? String(this.fieldDataArray[STRING_INDEX.EXCHG]) : null
    };
    return out;
  };
}

function getNewTopicData(topicName) {
  const feedType = topicName.split('|')[0];
  if (feedType === TopicTypes.INDEX) return new IndexTopicData(topicName);
  if (feedType === TopicTypes.SCRIP) return new ScripTopicData(topicName);
  return null;
}

function getStatus(buf, pos) {
  let status = BinRespStat.NOT_OK;
  const fieldCount = buf2Long(buf.subarray(pos, pos + 1));
  pos += 1;
  if (fieldCount > 0) {
    pos += 1;
    const fieldlength = buf2Long(buf.subarray(pos, pos + 2));
    pos += 2;
    status = buf2String(buf.subarray(pos, pos + fieldlength));
  }
  return status;
}

function parseBinary(data, onAck) {
  const e = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let pos = 0;
  const packetsCount = buf2Long(e.subarray(pos, pos + 2));
  pos += 2;
  const type = buf2Long(e.subarray(pos, pos + 1));
  pos += 1;

  if (type === BinRespTypes.CONNECTION_TYPE) {
    const fCount = buf2Long(e.subarray(pos, pos + 1));
    pos += 1;
    let status = BinRespStat.NOT_OK;
    if (fCount >= 1) {
      pos += 1;
      const valLen = buf2Long(e.subarray(pos, pos + 2));
      pos += 2;
      status = buf2String(e.subarray(pos, pos + valLen));
      pos += valLen;
    }
    if (fCount >= 2 && pos < e.length) {
      pos += 1;
      const valLen2 = buf2Long(e.subarray(pos, pos + 2));
      pos += 2;
      if (valLen2 > 0 && pos + valLen2 <= e.length) {
        ackNum = buf2Long(e.subarray(pos, pos + valLen2));
      }
    }
    return JSON.stringify([{
      stat: status === BinRespStat.OK ? 'Ok' : 'NotOk',
      type: 'cn',
      msg: status === BinRespStat.OK ? 'successful' : 'failed'
    }]);
  }

  if (type === BinRespTypes.DATA_TYPE) {
    if (ackNum > 0) {
      counter++;
      const msgNum = buf2Long(e.subarray(pos, pos + 4));
      pos += 4;
      if (counter === ackNum) {
        counter = 0;
        if (typeof onAck === 'function') onAck(msgNum);
      }
    }
    const result = [];
    const packetCount = buf2Long(e.subarray(pos, pos + 2));
    pos += 2;
    for (let n = 0; n < packetCount; n++) {
      pos += 2;
      const respType = buf2Long(e.subarray(pos, pos + 1));
      pos += 1;
      if (respType === ResponseTypes.SNAP) {
        const topicId = buf2Long(e.subarray(pos, pos + 4));
        pos += 4;
        const nameLen = buf2Long(e.subarray(pos, pos + 1));
        pos += 1;
        const topicName = buf2String(e.subarray(pos, pos + nameLen));
        pos += nameLen;
        const d = getNewTopicData(topicName);
        if (d) {
          topicList[topicId] = d;
          let fcount = buf2Long(e.subarray(pos, pos + 1));
          pos += 1;
          for (let i = 0; i < fcount; i++) {
            d.setLongValues(i, buf2Long(e.subarray(pos, pos + 4)));
            pos += 4;
          }
          d.setMultiplierAndPrec();
          fcount = buf2Long(e.subarray(pos, pos + 1));
          pos += 1;
          for (let i = 0; i < fcount; i++) {
            const fid = buf2Long(e.subarray(pos, pos + 1));
            pos += 1;
            const dataLen = buf2Long(e.subarray(pos, pos + 1));
            pos += 1;
            d.setStringValues(fid, buf2String(e.subarray(pos, pos + dataLen)));
            pos += dataLen;
          }
          result.push(d.prepareData());
        }
      } else if (respType === ResponseTypes.UPDATE) {
        const topicId = buf2Long(e.subarray(pos, pos + 4));
        pos += 4;
        const d = topicList[topicId];
        if (d) {
          const fcount = buf2Long(e.subarray(pos, pos + 1));
          pos += 1;
          for (let i = 0; i < fcount; i++) {
            d.setLongValues(i, buf2Long(e.subarray(pos, pos + 4)));
            pos += 4;
          }
          result.push(d.prepareData());
        }
      }
    }
    return JSON.stringify(result);
  }

  if (type === BinRespTypes.SUBSCRIBE_TYPE) {
    const status = getStatus(e, pos);
    return JSON.stringify([{
      stat: status === BinRespStat.OK ? 'Ok' : 'NotOk',
      type: 'sub',
      msg: status === BinRespStat.OK ? 'successful' : 'subscription failed'
    }]);
  }

  return null;
}

function parseMessage(data, onAck) {
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > 2) {
      const firstTwo = buf[0] << 8 | buf[1];
      if (firstTwo === 0x1f8b || buf[0] === 0x78) {
        try {
          const inflated = pako.inflate(new Uint8Array(buf));
          return parseBinary(Buffer.from(inflated), onAck);
        } catch (_) {}
      }
    }
    return parseBinary(buf, onAck);
  }
  const str = data.toString();
  if (typeof str === 'string' && /^[A-Za-z0-9+/=]+$/.test(str.trim())) {
    try {
      const decoded = decodeData(str);
      return parseBinary(decoded, onAck);
    } catch (err) {
      return str;
    }
  }
  return str;
}

function setAckNum(n) {
  ackNum = n;
}

module.exports = { parseMessage, parseBinary, setAckNum };
