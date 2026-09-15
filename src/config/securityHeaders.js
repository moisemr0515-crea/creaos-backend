const helmetOptions = {
  // La API solo devuelve JSON: no necesita ejecutar scripts ni cargar assets.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'none'"],
    },
  },
};

module.exports = { helmetOptions };
