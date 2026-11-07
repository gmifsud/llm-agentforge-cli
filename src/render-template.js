'use strict';

const fs = require('node:fs');
const { failure } = require('./domain/errors');

/** Literal `${KEY}` replacement. No regex, no escaping semantics. */
function renderString(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split('${' + k + '}').join(String(v));
  }
  return out;
}

function renderTemplateFile(templatePath, vars) {
  if (!fs.existsSync(templatePath)) throw failure('TEMPLATE_MISSING', `template not found: ${templatePath}`);
  return renderString(fs.readFileSync(templatePath, 'utf8'), vars);
}

module.exports = { renderString, renderTemplateFile };
