const obj = {
  abc() {
    // This actually refers to itself!?
    console.log(this);
  },
  crazy: function () {
    console.log(this);
  },
  start: () => {

  },
};

console.log(obj.crazy());
