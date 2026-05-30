const success = (data = null, message = "OK") => ({
  success: true,
  data,
  message
});

const failure = (message = "Something went wrong", data = null) => ({
  success: false,
  data,
  message
});

module.exports = {
  success,
  failure
};
