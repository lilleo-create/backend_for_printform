export const money = {
  toRublesFloat(valueKopecks: number) {
    return valueKopecks / 100;
  },
  toRublesString(valueKopecks: number) {
    return (valueKopecks / 100).toFixed(2);
  },
  toKopecks(valueRubles: number) {
    const result = Math.round(valueRubles * 100);
    console.info('[MONEY]', {
      rubles: valueRubles,
      kopecks: result
    });
    return result;
  }
};

export const rublesToKopecks = money.toKopecks;
export const kopecksToRubles = money.toRublesString;
