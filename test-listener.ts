const et = new EventTarget();

function abc() {
  console.log('abc');
}

et.addEventListener(
  'abc',
  abc
);

console.log(et.addEventListener(
  'abc',
  abc,
  { capture: true }
));

et.dispatchEvent(new Event('abc'));

// So it's possible that an event listener is already the same
// It only makes sense to know IF there are no listeners whatsoever
// Plus we don't this information, it doesn't tell us
// Unless we keep track of the listener instances ourselves
// There's no way to do this

// What are the alternatives?
