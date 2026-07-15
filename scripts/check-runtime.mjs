const minimum = [22, 13, 0];
const actual = process.versions.node.split(".").map(Number);

const supported = actual[0] > minimum[0] ||
  (actual[0] === minimum[0] && (actual[1] > minimum[1] ||
    (actual[1] === minimum[1] && actual[2] >= minimum[2])));

if (!supported) {
  console.error(`CodeXH requires Node.js >=${minimum.join(".")}; found ${process.versions.node}.`);
  console.error("Install the version declared in .node-version, then reinstall dependencies if needed.");
  process.exit(1);
}
