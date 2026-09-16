function jsTarget(value) {
  return value + 1;
}

function jsCaller() {
  return jsTarget(3);
}

module.exports = { jsTarget, jsCaller };
