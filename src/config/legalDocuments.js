const LEGAL_DOCUMENTS = Object.freeze({
  terms: Object.freeze({ documentType: 'terms', documentVersion: '1.0.0' }),
  privacy: Object.freeze({ documentType: 'privacy', documentVersion: '1.0.0' }),
});

const CURRENT_LEGAL_VERSIONS = Object.freeze({
  termsVersion: LEGAL_DOCUMENTS.terms.documentVersion,
  privacyVersion: LEGAL_DOCUMENTS.privacy.documentVersion,
});

const isCurrentLegalAcceptance = (acceptance) => Boolean(
  acceptance
  && acceptance.termsAccepted === true
  && acceptance.privacyAccepted === true
  && acceptance.termsVersion === CURRENT_LEGAL_VERSIONS.termsVersion
  && acceptance.privacyVersion === CURRENT_LEGAL_VERSIONS.privacyVersion
);

module.exports = {
  LEGAL_DOCUMENTS,
  CURRENT_LEGAL_VERSIONS,
  isCurrentLegalAcceptance,
};
