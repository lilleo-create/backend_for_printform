export const rublesToKopecks = (value: number) => {
  const result = Math.round(value * 100);
  console.info('[MONEY]', {
    rubles: value,
    kopecks: result
  });
  return result;
};

export const kopecksToRubles = (value: number) => {
  return (value / 100).toFixed(2);
};
