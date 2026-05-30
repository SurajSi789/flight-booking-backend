const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);
const addHours = (date, hours) => new Date(date.getTime() + hours * 60 * 60 * 1000);
const toIso = (date) => new Date(date).toISOString();

module.exports = {
  addMinutes,
  addHours,
  toIso
};
