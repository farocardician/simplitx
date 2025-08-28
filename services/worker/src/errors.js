class GatewayError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = {
  GatewayError
};