const { promises: fsPromises } = require('fs');
const jsdom = require('jsdom');
const path = require('path');
const htmlMinifier = require('html-minifier');
const prettify = require('pretty');
const { webcrypto } = require('crypto');

const { readFile } = fsPromises;
const { JSDOM } = jsdom;

const textDecoder = new TextDecoder();

let srcDir = '';
let document;

const resolvePath = (src) => path.resolve(process.cwd(), src.trim());

const resolveDirPath = (src) => (`${srcDir}/${src}`);

const getFile = (src) => readFile(resolvePath(src));

const getFileString = (src, format) => getFile(src)
  .then((buffer) => Promise.resolve(buffer.toString(format)));

const bytesToBase64 = (bytes) => btoa(bytes.reduce((data, byte) => data + String.fromCharCode(byte), ''));

const getFetchString = async (src, integrity) => {
  const resp = await fetch(src);

  if (!resp.ok) {
    throw new Error(resp.statusText);
  }

  const buffer = new Uint8Array(await resp.arrayBuffer());

  if (integrity) {
    const hash = `sha384-${bytesToBase64(new Uint8Array(await webcrypto.subtle.digest('SHA-384', buffer)))}`;

    if (integrity !== hash) {
      throw new Error(`${integrity} mismatch with ${hash}`);
    }

    console.log(`[Log] verified ${hash} : ${src}`);
  }

  return textDecoder.decode(buffer);
};

const base64Map = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/jpeg',
};

const ignoreSourceStartingWith = [
  'http://',
  'https://',
];

const containsIgnoreSourceStartingWith = (src) => ignoreSourceStartingWith
  .some((ignoreString) => src.startsWith(ignoreString));

const resolveImageToBase64 = ({ element, srcAttributeName = 'src' }) => {
  const src = element.getAttribute(srcAttributeName);
  if (!src || src.startsWith('http')) return Promise.resolve();
  return getFileString(resolveDirPath(src), 'base64').then((base64String) => {
    element.setAttribute(srcAttributeName, `data:${base64Map[path.extname(src).slice(1)] || 'image'};base64, ${base64String}`);
  });
};

const resolveExternalScript = async ({ element }) => {
  const srcAttr = element.getAttribute('src');

  if (!srcAttr) {
    return;
  }

  if (containsIgnoreSourceStartingWith(srcAttr)) {
    const file = await getFetchString(srcAttr, element.getAttribute('integrity'));

    element.innerHTML = file;
    element.removeAttribute('src');

    return;
  }

  const file = await getFileString(resolveDirPath(srcAttr));

  element.innerHTML = file;
  element.removeAttribute('src');
};

const resolveExternalIcon = async ({ element }) => {
  if (!element.getAttribute('href')) return Promise.resolve();
  if (containsIgnoreSourceStartingWith(element.getAttribute('href'))) return Promise.resolve();
  return resolveImageToBase64({ element, srcAttributeName: 'href' });
};

const resolveExternalStyleSheet = ({ element }) => {
  const href = element.getAttribute('href');
  const { parentElement } = element;

  if (!href) return Promise.resolve();
  if (containsIgnoreSourceStartingWith(element.getAttribute('href'))) {
    return getFetchString(element.getAttribute('href')).then((file) => {
      const style = document.createElement('style');
      style.innerHTML = file;
      parentElement.replaceChild(style, element);
    });
  }

  return getFileString(resolveDirPath(href)).then((file) => {
    const style = document.createElement('style');
    style.innerHTML = file;
    parentElement.replaceChild(style, element);
  });
};

const resolveExternalLink = ({ element }) => {
  switch (element.getAttribute('rel')) {
    case 'stylesheet':
      return resolveExternalStyleSheet({ element });

    case 'icon':
      return resolveExternalIcon({ element });
    default:
      return Promise.resolve();
  }
};

const resolveElement = (element, tagName) => {
  switch (tagName) {
    case 'script':
      return resolveExternalScript({ element });
    case 'link':
      return resolveExternalLink({ element });
    case 'img':
      return resolveImageToBase64({ element });
    default:
      return Promise.resolve();
  }
};

const resolveTag = (tagName) => Promise.all(
  Array.from(document.getElementsByTagName(tagName.trim()))
    .map((element) => resolveElement(element, tagName)),
);

const htmlInlineExternal = ({
  src, tags = ['script', 'link', 'img'], pretty, minify,
}) => getFileString(src).then((fileString) => {
  const dom = new JSDOM(fileString);
  document = dom.window.document;
  srcDir = path.dirname(src);
  return Promise.all(tags.map((tag) => resolveTag(tag))).then(() => {
    let resolvedDOM = dom.serialize();
    if (pretty) resolvedDOM = prettify(resolvedDOM);
    else if (minify) {
      resolvedDOM = htmlMinifier.minify(resolvedDOM,
        { collapseWhitespace: true, minifyCSS: true, minifyJS: true });
    }
    return Promise.resolve(resolvedDOM);
  });
});

module.exports = htmlInlineExternal;
