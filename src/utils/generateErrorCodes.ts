/**
 * Generate FIELD_MISSING error code
 */
const generateMissingCode = (missingField: string) => {
    if (missingField) return `${missingField.toUpperCase()}_MISSING`
    else return '';
}

/**
 * Generate MODEL_NOT_FOUND error code
 */
const generateNotFoundCode = (model: string) => {
    if (model) return `${model.toUpperCase()}_NOT_FOUND`;
    else return '';
}

/**
 * Generate INVALID_MODEL error code
 */
const generateInvalidCode = (model: string) => {
    if (model) return `INVALID_${model.toUpperCase()}`;
    else return '';
}

export {generateMissingCode, generateNotFoundCode, generateInvalidCode};
