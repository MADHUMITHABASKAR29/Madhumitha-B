// js/questions.js
const QUESTIONS = [
  {
    topic  : 'Data Structures',
    text   : 'Which data structure operates on the LIFO (Last-In, First-Out) principle?',
    options: ['Queue', 'Stack', 'Linked List', 'Binary Tree'],
    answer : 1
  },
  {
    topic  : 'Algorithms',
    text   : 'What is the worst-case time complexity of QuickSort?',
    options: ['O(n log n)', 'O(n²)', 'O(n)', 'O(log n)'],
    answer : 1
  },
  {
    topic  : 'Computer Networks',
    text   : 'Which OSI layer is responsible for routing packets between networks?',
    options: ['Data Link Layer', 'Transport Layer', 'Network Layer', 'Session Layer'],
    answer : 2
  },
  {
    topic  : 'Operating Systems',
    text   : 'Deadlock requires which four conditions to hold simultaneously?',
    options: [
      'Mutual exclusion, Hold & wait, No preemption, Circular wait',
      'Paging, Segmentation, Swapping, Compaction',
      'Scheduling, Synchronisation, Caching, Buffering',
      'Interrupts, Exceptions, Traps, Faults'
    ],
    answer : 0
  },
  {
    topic  : 'Databases',
    text   : 'Which normal form eliminates transitive dependencies among non-key attributes?',
    options: ['1NF', '2NF', '3NF', 'BCNF'],
    answer : 2
  }
];
