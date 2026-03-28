'use strict';

const MAX_SCRIPS = 100;
const BinRespTypes = {
  CONNECTION_TYPE: 1,
  THROTTLING_TYPE: 2,
  ACK_TYPE: 3,
  SUBSCRIBE_TYPE: 4,
  UNSUBSCRIBE_TYPE: 5
};
const INDEX_PREFIX = 'if';
const SCRIP_PREFIX = 'sf';
const DEPTH_PREFIX = 'dp';

function ByteData(size) {
  this.pos = 0;
  this.bytes = Buffer.alloc(size);
  this.startOfMsg = 0;
  this.markStartOfMsg = function () {
    this.startOfMsg = this.pos;
    this.pos += 2;
  };
  this.markEndOfMsg = function () {
    const len = this.pos - this.startOfMsg - 2;
    this.bytes[this.startOfMsg] = (len >> 8) & 255;
    this.bytes[this.startOfMsg + 1] = len & 255;
  };
  this.appendByte = function (d) {
    this.bytes[this.pos++] = d;
  };
  this.appendShort = function (d) {
    this.bytes[this.pos++] = (d >> 8) & 255;
    this.bytes[this.pos++] = d & 255;
  };
  this.appendInt = function (d) {
    this.bytes[this.pos++] = (d >> 24) & 255;
    this.bytes[this.pos++] = (d >> 16) & 255;
    this.bytes[this.pos++] = (d >> 8) & 255;
    this.bytes[this.pos++] = d & 255;
  };
  this.appendString = function (d) {
    for (let i = 0; i < d.length; i++) {
      this.bytes[this.pos++] = d.charCodeAt(i);
    }
  };
  this.appendByteArr = function (arr, len) {
    for (let i = 0; i < len; i++) {
      this.bytes[this.pos++] = arr[i];
    }
  };
  this.getBytes = function () {
    return this.bytes.subarray(0, this.pos);
  };
}

function isScripOK(scripsStr) {
  const count = scripsStr.split('&').length;
  if (count > MAX_SCRIPS) {
    console.error('[hsmProtocol] Maximum scrips allowed per request is ' + MAX_SCRIPS);
    return false;
  }
  return true;
}

function getScripByteArray(scripsStr, prefix) {
  let s = scripsStr;
  if (s.charCodeAt(s.length - 1) === 38) s = s.substring(0, s.length - 1);
  const scripArray = s.split('&');
  const scripsCount = scripArray.length;
  let dataLen = 0;
  for (let i = 0; i < scripsCount; i++) {
    scripArray[i] = prefix + '|' + scripArray[i];
    dataLen += scripArray[i].length + 1;
  }
  const bytes = Buffer.alloc(dataLen + 2);
  let pos = 0;
  bytes[pos++] = (scripsCount >> 8) & 255;
  bytes[pos++] = scripsCount & 255;
  for (let i = 0; i < scripsCount; i++) {
    const curr = scripArray[i];
    const scripLen = curr.length;
    bytes[pos++] = scripLen & 255;
    for (let j = 0; j < scripLen; j++) {
      bytes[pos++] = curr.charCodeAt(j);
    }
  }
  return bytes;
}

function prepareConnectionRequest2(jwt, redisKey) {
  const src = 'JS_API';
  const srcLen = src.length;
  const jwtLen = jwt.length;
  const redisLen = redisKey.length;
  const buffer = new ByteData(srcLen + jwtLen + redisLen + 13);
  buffer.markStartOfMsg();
  buffer.appendByte(BinRespTypes.CONNECTION_TYPE);
  buffer.appendByte(3);
  buffer.appendByte(1);
  buffer.appendShort(jwtLen);
  buffer.appendString(jwt);
  buffer.appendByte(2);
  buffer.appendShort(redisLen);
  buffer.appendString(redisKey);
  buffer.appendByte(3);
  buffer.appendShort(srcLen);
  buffer.appendString(src);
  buffer.markEndOfMsg();
  return buffer.getBytes();
}

function prepareSubsUnSubsRequest(scripsStr, type, prefix, channelNum) {
  if (!isScripOK(scripsStr)) return null;
  const dataArr = getScripByteArray(scripsStr, prefix);
  const buffer = new ByteData(dataArr.length + 11);
  buffer.markStartOfMsg();
  buffer.appendByte(type);
  buffer.appendByte(2);
  buffer.appendByte(1);
  buffer.appendShort(dataArr.length);
  buffer.appendByteArr(dataArr, dataArr.length);
  buffer.appendByte(2);
  buffer.appendShort(1);
  buffer.appendByte(channelNum);
  buffer.markEndOfMsg();
  return buffer.getBytes();
}

function buildConnectionPacket(token, sid) {
  return prepareConnectionRequest2(token, sid);
}

function buildIndexSubscribePacket(indicesStr, channelNum) {
  return prepareSubsUnSubsRequest(
    indicesStr,
    BinRespTypes.SUBSCRIBE_TYPE,
    INDEX_PREFIX,
    channelNum
  );
}

function buildScripSubscribePacket(scriptsStr, channelNum) {
  return prepareSubsUnSubsRequest(
    scriptsStr,
    BinRespTypes.SUBSCRIBE_TYPE,
    SCRIP_PREFIX,
    channelNum
  );
}

function buildAckPacket(msgNum) {
  const buffer = new ByteData(11);
  buffer.markStartOfMsg();
  buffer.appendByte(BinRespTypes.ACK_TYPE);
  buffer.appendByte(1);
  buffer.appendByte(1);
  buffer.appendShort(4);
  buffer.appendInt(msgNum);
  buffer.markEndOfMsg();
  return buffer.getBytes();
}

module.exports = {
  buildConnectionPacket,
  buildIndexSubscribePacket,
  buildScripSubscribePacket,
  buildAckPacket,
  INDEX_PREFIX,
  SCRIP_PREFIX,
  DEPTH_PREFIX
};
