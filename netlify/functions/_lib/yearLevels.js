// Word-count and question-count tables, ported/extended from
// reading-dojo_1.html (which covered Year 3-10) to also cover Year 2.

const WORD_TARGET_BY_YEAR = {
  2: "70-110",
  3: "110-150",
  4: "150-190",
  5: "190-230",
  6: "220-260",
  7: "250-290",
  8: "270-320",
  9: "320-380",
  10: "360-430",
};

function wordTargetForYear(year) {
  return WORD_TARGET_BY_YEAR[year] || "180-220";
}

function questionCountForYear(year) {
  if (year <= 4) return 5;
  if (year <= 6) return 8;
  if (year <= 8) return 12;
  return 16;
}

// Mostly multiple-choice with a handful of short-answer, scaling with year
// level so grading stays fast and matches the confirmed mixed-format brief.
function questionMixForYear(year) {
  const total = questionCountForYear(year);
  const shortAnswerCount = year <= 4 ? 1 : year <= 8 ? 2 : 3;
  return { total, shortAnswerCount, multipleChoiceCount: total - shortAnswerCount };
}

module.exports = { wordTargetForYear, questionCountForYear, questionMixForYear };
