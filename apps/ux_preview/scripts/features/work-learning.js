/* Learning work kinds: quizzes (staff quizzes published to a course, and
   private practice quizzes with instant feedback) and study guides.
   Content is generated from canned, cited banks keyed by document id, with a
   fallback built from document names. Engine + shell: features/work.js. */
(() => {
  'use strict';

  const C = (doc, page, quote) => ({ doc, page, quote });
  const Q = (doc, page, quote, difficulty, topic, q, options, answer, explain) => ({ q, options, answer, difficulty, topic, explain, cite: C(doc, page, quote) });
  const KEYS = 'ABCD';
  const DIFF = { easy: ['Easy', 'success'], medium: ['Medium', 'default'], hard: ['Hard', 'warning'] };

  /* ═══════════════ Question banks (by document) ═══════════════ */
  const BANK = {
    'du-ml-w02': [
      Q('du-ml-w02', 6, 'The model predicts ŷ = wᵀx and is trained by minimizing the mean squared error between predictions and targets.', 'easy', 'the training loss', 'What does linear regression minimize during training?', ['The mean squared error between predictions and targets', 'The number of misclassified points', 'The cross-entropy loss', 'The absolute value of the weights'], 0, 'Linear regression picks the weights that make the average squared error as small as possible.'),
      Q('du-ml-w02', 15, 'Each iteration updates every weight by w ← w − α·∂J/∂w, moving against the gradient.', 'easy', 'the update rule', 'In one gradient descent step, how is each weight updated?', ['w ← w + α·∂J/∂w', 'w ← w − α·∂J/∂w', 'w ← α·w', 'w ← w − ∂J/∂α'], 1, 'Gradient descent moves against the gradient, scaled by the learning rate α.'),
      Q('du-ml-w02', 18, 'If α is too large gradient descent can overshoot and diverge; if it is too small, convergence is slow.', 'medium', 'choosing the learning rate', 'The loss grows after every gradient descent iteration. What is the most likely cause?', ['The learning rate α is too large', 'The learning rate α is too small', 'There are too few features', 'The features are standardized'], 0, 'A step that is too large overshoots the minimum, so each update makes the loss worse.'),
      Q('du-ml-w02', 21, 'When features have very different ranges the loss contours are elongated and gradient descent zig-zags; scaling features fixes this.', 'easy', 'feature scaling', 'Why standardize features before running gradient descent?', ['It makes the loss convex', 'It helps gradient descent converge faster', 'It removes outliers', 'The normal equation requires it'], 1, 'With features on similar scales the loss surface is rounder, so each step points more directly at the minimum.'),
      Q('du-ml-w02', 25, 'The normal equation w = (XᵀX)⁻¹Xᵀy gives the exact minimizer of the squared error.', 'medium', 'the normal equation', 'What is the closed-form solution for the linear regression weights?', ['w = Xᵀy', 'w = (XᵀX)⁻¹Xᵀy', 'w = (XXᵀ)⁻¹y', 'w = X⁻¹y'], 1, 'The normal equation solves for the weights in one step, without iterating.'),
      Q('du-ml-w02', 27, 'Inverting XᵀX costs roughly O(n³) in the number of features; for large n prefer gradient descent.', 'hard', 'gradient descent vs. the normal equation', 'When is gradient descent preferred over the normal equation?', ['When there are very many features', 'When there are only two features', 'When the data has no noise', 'Never — the normal equation is always better'], 0, 'Inverting XᵀX grows roughly with the cube of the number of features, so it becomes too slow for large feature sets.'),
      Q('du-ml-w02', 30, 'Stochastic gradient descent estimates the gradient from a single example or a mini-batch, trading noise for speed.', 'medium', 'stochastic gradient descent', 'What does stochastic gradient descent use to compute each update?', ['The whole training set', 'One example or a small mini-batch', 'Only the validation set', 'The test set'], 1, 'SGD uses one example (or a mini-batch) per step: noisier updates, but far more of them per second.'),
    ],
    'du-ml-w03': [
      Q('du-ml-w03', 5, 'The sigmoid σ(z) = 1/(1+e⁻ᶻ) maps any real number to a value between 0 and 1, read as the probability of class 1.', 'easy', 'the sigmoid output', 'What does the sigmoid function output in logistic regression?', ['A class label, 0 or 1', 'A probability between 0 and 1', 'Any real number', 'The distance to the decision boundary'], 1, 'The sigmoid squashes the score wᵀx into (0, 1), read as the probability of the positive class.'),
      Q('du-ml-w03', 8, 'Predicting class 1 when σ(wᵀx) ≥ 0.5 is the same as wᵀx ≥ 0, so the decision boundary is linear in x.', 'medium', 'the decision boundary', 'The decision boundary of logistic regression is…', ['Always a circle', 'Linear in the input features', 'Undefined', 'Always at x = 0.5'], 1, 'σ(wᵀx) ≥ 0.5 exactly when wᵀx ≥ 0, which is a straight line (a hyperplane) in feature space.'),
      Q('du-ml-w03', 11, 'Logistic regression is trained by minimizing the cross-entropy loss, which is convex in the weights.', 'easy', 'the training loss', 'Which loss is used to train logistic regression?', ['Mean squared error', 'Cross-entropy (log loss)', 'Hinge loss', 'Absolute error'], 1, 'Cross-entropy penalizes confident wrong predictions heavily and keeps the problem convex.'),
      Q('du-ml-w03', 12, 'Combining the sigmoid with squared error gives a non-convex cost; cross-entropy keeps the problem convex.', 'hard', 'why not squared error', 'Why is mean squared error a poor choice for logistic regression?', ['It is too slow to compute', 'With the sigmoid it makes the loss non-convex, with local minima', 'It cannot be differentiated', 'It only works with one feature'], 1, 'Squared error on top of a sigmoid is non-convex, so gradient descent can get stuck.'),
      Q('du-ml-w03', 20, 'One-vs-rest trains one binary classifier per class and predicts the class whose classifier gives the highest probability.', 'medium', 'one-vs-rest', 'How does one-vs-rest handle a problem with 4 classes?', ['One classifier for all classes at once', '4 binary classifiers; pick the most confident', '6 pairwise classifiers', 'It can’t handle more than 2 classes'], 1, 'One classifier per class, each separating that class from the rest; the highest probability wins.'),
      Q('du-ml-w03', 27, 'Precision is TP / (TP + FP): of everything predicted positive, how much really is positive.', 'hard', 'computing precision', 'A spam filter flags 90 of 100 spam emails and also flags 30 normal ones. What is its precision?', ['90%', '75%', '30%', '10%'], 1, 'Precision = TP / (TP + FP) = 90 / (90 + 30) = 75%.'),
      Q('du-ml-w03', 29, 'A higher threshold predicts positive less often: precision tends to rise while recall falls.', 'medium', 'moving the threshold', 'Raising the classification threshold from 0.5 to 0.8 usually…', ['Increases recall', 'Increases precision and lowers recall', 'Has no effect', 'Increases both precision and recall'], 1, 'The model says “positive” only when very sure: fewer false positives, but more missed positives.'),
    ],
    'du-ml-w04': [
      Q('du-ml-w04', 3, 'An overfit model fits the training data, including its noise, so well that it performs poorly on new data.', 'easy', 'overfitting', 'What is overfitting?', ['The model is too simple to fit the training data', 'The model fits noise in the training data and generalizes poorly', 'The model trains too slowly', 'The training set is too large'], 1, 'An overfit model memorizes the training set, noise included, and does worse on new data.'),
      Q('du-ml-w04', 7, 'L2 regularization adds λ‖w‖² to the loss, shrinking all weights toward zero without making them exactly zero.', 'easy', 'the L2 penalty', 'Which term does L2 regularization add to the loss?', ['λ‖w‖₁', 'λ‖w‖²', 'λ·n', 'λ·log(w)'], 1, 'L2 (ridge) penalizes the squared norm of the weights.'),
      Q('du-ml-w04', 11, 'L1 regularization (lasso) can set weights exactly to zero, which performs feature selection.', 'medium', 'L1 and sparsity', 'Which regularizer tends to produce sparse weights?', ['L2', 'L1', 'Dropout', 'Early stopping'], 1, 'The L1 penalty drives some weights exactly to zero.'),
      Q('du-ml-w04', 15, 'High variance: training error is low but validation error is much higher. High bias: both errors are high.', 'medium', 'diagnosing variance', 'Training error is 2%, validation error 19%. What is the most likely problem?', ['High bias', 'High variance', 'Too much regularization', 'A bug in the validation set'], 1, 'A large gap between training and validation error signals overfitting (high variance).'),
      Q('du-ml-w04', 16, 'With high bias, more data rarely helps; use a more flexible model, add features or reduce λ.', 'hard', 'fixing high bias', 'Training and validation error are both high (25% and 27%). What helps most?', ['Collect more training data', 'Use a more flexible model or reduce λ', 'Increase λ', 'Remove features'], 1, 'Both errors high means underfitting: the model needs more capacity, not more data.'),
      Q('du-ml-w04', 18, 'Increasing λ reduces variance but can increase bias; choose λ on a validation set.', 'easy', 'the effect of λ', 'What usually happens as λ increases?', ['Variance increases, bias decreases', 'Both decrease', 'Variance decreases, bias increases', 'Nothing changes'], 2, 'Stronger regularization makes the model simpler: less variance, more bias.'),
      Q('du-ml-w04', 21, 'Select λ with k-fold cross-validation; never tune hyper-parameters on the test set.', 'hard', 'choosing λ', 'How should λ be chosen?', ['On the test set', 'On the training set', 'With a validation set or cross-validation', 'Always λ = 1'], 2, 'The test set must stay untouched; tune hyper-parameters on validation data.'),
    ],
    'du-ml-w05': [
      Q('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.', 'easy', 'Gini impurity', 'Which impurity measure does CART use for classification by default?', ['Entropy', 'Gini impurity', 'Mean squared error', 'Hinge loss'], 1, 'CART splits on Gini impurity unless told otherwise.'),
      Q('du-ml-w05', 10, 'Information gain is the drop in entropy from the parent node to the weighted average of its children.', 'medium', 'information gain', 'What does information gain measure for a split?', ['How many samples go left', 'The drop in entropy after the split', 'The depth of the tree', 'The accuracy on the test set'], 1, 'A good split makes the children purer than the parent; information gain measures that drop in entropy.'),
      Q('du-ml-w05', 15, 'Unpruned trees grow until leaves are pure and overfit; limit depth, require a minimum leaf size, or prune.', 'easy', 'stopping overfitting in trees', 'How can you stop a decision tree from overfitting?', ['Grow it until every leaf is pure', 'Limit the depth or prune it', 'Use more features at every split', 'Remove the root node'], 1, 'Limiting depth or leaf size, or pruning afterwards, keeps the tree from memorizing the data.'),
      Q('du-ml-w05', 22, 'Bagging trains each model on a bootstrap sample of the training set and averages their predictions.', 'medium', 'bagging', 'What is bagging?', ['Training models in sequence on each other’s errors', 'Training models on bootstrap samples and averaging them', 'Choosing the single best tree', 'Removing duplicate rows'], 1, 'Bootstrap aggregating: many models on resampled data, averaged to reduce variance.'),
      Q('du-ml-w05', 27, 'Sampling a subset of features at each split decorrelates the trees, so averaging them reduces variance.', 'medium', 'feature sampling in forests', 'Why does a random forest sample features at each split?', ['Only to speed up training', 'To decorrelate the trees', 'To handle missing values', 'To make trees deeper'], 1, 'Feature sampling makes the trees less alike, so averaging them cancels out more of the variance.'),
      Q('du-ml-w05', 29, 'Each tree leaves out about a third of the samples; predicting them gives the out-of-bag error, a free validation estimate.', 'hard', 'out-of-bag error', 'What is the out-of-bag error of a random forest?', ['The error on the test set', 'The error on samples each tree did not see in its bootstrap sample', 'The error of the deepest tree', 'The training error'], 1, 'Each tree skips about a third of the data; scoring those left-out samples gives a validation estimate for free.'),
      Q('du-ml-w05', 33, 'Boosting builds models sequentially: each new tree concentrates on the examples the current ensemble gets wrong.', 'hard', 'boosting vs. bagging', 'How does boosting differ from bagging?', ['Boosting trains trees independently in parallel', 'Boosting trains trees in sequence, each fixing earlier errors', 'Boosting uses only one tree', 'There is no difference'], 1, 'Boosting is sequential and focuses on mistakes; bagging trains independent models and averages them.'),
    ],
    'du-ml-w06': [
      Q('du-ml-w06', 6, 'Without a non-linear activation, any number of layers is equivalent to a single linear transformation.', 'easy', 'why activations are non-linear', 'Why do neural networks need non-linear activation functions?', ['To speed up training', 'Without them, stacked layers collapse into one linear model', 'To save memory', 'To keep outputs positive'], 1, 'A stack of linear layers is still linear; non-linearities are what let the network fit curved boundaries.'),
      Q('du-ml-w06', 14, 'Backpropagation applies the chain rule layer by layer to compute the gradient of the loss with respect to every weight.', 'easy', 'backpropagation', 'What does backpropagation compute?', ['The network’s output', 'The gradient of the loss for every weight', 'The best learning rate', 'The number of hidden units'], 1, 'Backprop is the chain rule applied from the output back to the input, giving every weight’s gradient.'),
      Q('du-ml-w06', 19, 'Sigmoid saturates and its gradient vanishes for large inputs; ReLU keeps a gradient of 1 for positive inputs.', 'medium', 'vanishing gradients', 'Which activation helps against vanishing gradients in deep networks?', ['Sigmoid', 'ReLU', 'Step function', 'Linear'], 1, 'ReLU’s gradient is 1 for positive inputs, so it doesn’t shrink layer after layer like the sigmoid’s.'),
      Q('du-ml-w06', 24, 'For K classes use K output units with softmax, which turns scores into probabilities that sum to 1.', 'easy', 'the softmax output layer', 'For a 10-class classifier, which output layer is standard?', ['One sigmoid unit', '10 units with softmax', '10 units with ReLU', 'One linear unit'], 1, 'Softmax over 10 units gives a probability for each class that sums to 1.'),
      Q('du-ml-w06', 27, 'If all weights start equal, every unit in a layer receives the same gradient and they stay identical; initialize randomly.', 'hard', 'weight initialization', 'Why not initialize all weights to zero?', ['Training would be too fast', 'Every unit in a layer would learn the same thing', 'Zero isn’t allowed in floating point', 'It causes exploding gradients'], 1, 'Identical weights get identical gradients, so the units never become different. Random initialization breaks the symmetry.'),
      Q('du-ml-w06', 31, 'Dropout randomly sets a fraction of units to zero at each training step, which acts as regularization.', 'medium', 'dropout', 'What does dropout do during training?', ['Removes layers permanently', 'Randomly turns off units so the network can’t rely on any one', 'Lowers the learning rate', 'Drops training examples'], 1, 'Dropout switches off random units at each step, which keeps the network from depending on any single one.'),
      Q('du-ml-w06', 35, 'Early stopping keeps the weights from the epoch with the lowest validation loss.', 'medium', 'early stopping', 'Validation loss starts rising while training loss keeps falling. What should you do?', ['Train for longer', 'Stop early and keep the best checkpoint', 'Increase the learning rate', 'Remove the validation set'], 1, 'Rising validation loss means overfitting has started; keep the weights from the best validation epoch.'),
    ],
    'du-db-w05': [
      Q('du-db-w05', 6, 'INNER JOIN returns only the rows where the join condition matches in both tables.', 'easy', 'INNER JOIN', 'Which join returns only rows that have a match in both tables?', ['LEFT JOIN', 'INNER JOIN', 'FULL OUTER JOIN', 'CROSS JOIN'], 1, 'INNER JOIN keeps only matching pairs.'),
      Q('du-db-w05', 9, 'LEFT JOIN keeps every row of the left table; columns of the right table are NULL when there is no match.', 'medium', 'LEFT JOIN', 'You want every student, including those not enrolled in any course. Which query shape?', ['Student INNER JOIN Enrollment', 'Student LEFT JOIN Enrollment', 'Enrollment INNER JOIN Course', 'Student CROSS JOIN Course'], 1, 'LEFT JOIN keeps all students; their enrollment columns are NULL when they have none.'),
      Q('du-db-w05', 12, 'A CROSS JOIN returns the Cartesian product: every row of the first table paired with every row of the second.', 'easy', 'CROSS JOIN', 'How many rows does a CROSS JOIN of a 20-row table and a 5-row table return?', ['25', '100', '20', '5'], 1, 'Every row pairs with every row: 20 × 5 = 100.'),
      Q('du-db-w05', 14, 'Comparisons with NULL are never true; use IS NULL to find rows that had no match.', 'hard', 'finding rows without a match', 'After Student s LEFT JOIN Enrollment e, which condition finds students with no enrollment?', ['WHERE e.student_id = NULL', 'WHERE e.student_id IS NULL', 'WHERE e.student_id <> NULL', 'HAVING COUNT(*) = 0'], 1, '= NULL is never true in SQL; IS NULL is the only correct test.'),
      Q('du-db-w05', 22, 'A correlated subquery refers to columns of the outer query, so it is evaluated once for each outer row.', 'medium', 'correlated subqueries', 'What makes a subquery “correlated”?', ['It runs once for the whole query', 'It refers to the outer row and is evaluated per row', 'It must be in the FROM clause', 'It cannot use WHERE'], 1, 'Because it uses a column from the outer query, it is re-evaluated for each outer row.'),
      Q('du-db-w05', 27, 'If the subquery returns a NULL, NOT IN yields no rows; NOT EXISTS is not affected by NULLs.', 'hard', 'NOT IN vs. NOT EXISTS', 'Which is the safe choice when the subquery may return NULLs?', ['NOT IN', 'NOT EXISTS', '<> ALL', '= ANY'], 1, 'One NULL in the subquery makes NOT IN return nothing; NOT EXISTS is unaffected.'),
    ],
    'du-db-w07': [
      Q('du-db-w07', 3, 'Redundancy causes update, insertion and deletion anomalies; normalization stores each fact once.', 'easy', 'why normalize', 'Which problem does normalization prevent?', ['Slow queries', 'Update anomalies: the same fact stored in many rows', 'Deadlocks', 'Index fragmentation'], 1, 'Storing each fact once means one update changes it everywhere.'),
      Q('du-db-w07', 5, 'First normal form requires every attribute to hold a single, atomic value: no lists or repeating groups.', 'easy', '1NF', 'A table is in 1NF when…', ['It has a one-column primary key', 'Every attribute holds a single atomic value', 'It has no foreign keys', 'It has fewer than 10 columns'], 1, '1NF forbids lists and repeating groups inside a cell.'),
      Q('du-db-w07', 11, '2NF forbids partial dependencies: a non-key attribute depending on only part of a composite key.', 'medium', '2NF', 'A partial dependency violates which normal form?', ['1NF', '2NF', '3NF only', 'BCNF only'], 1, 'Partial dependencies on part of a composite key are what 2NF removes.'),
      Q('du-db-w07', 12, 'In Enrollment(student_id, course_id, course_name), course_name depends on course_id alone — a partial dependency.', 'medium', 'spotting a partial dependency', 'Enrollment(student_id, course_id, course_name) has key (student_id, course_id). What is wrong?', ['course_name depends only on course_id', 'It has a composite key', 'student_id is not unique', 'Nothing'], 0, 'course_name depends on part of the key, so move it to a Course table.'),
      Q('du-db-w07', 17, '3NF removes transitive dependencies: non-key attributes must depend on the key, the whole key and nothing but the key.', 'medium', '3NF', 'What does 3NF remove?', ['Repeating groups', 'Transitive dependencies of non-key attributes on the key', 'All foreign keys', 'Composite keys'], 1, 'In 3NF no non-key attribute depends on another non-key attribute.'),
      Q('du-db-w07', 23, 'A relation is in BCNF when, for every non-trivial functional dependency X → Y, X is a superkey.', 'hard', 'BCNF', 'When is a relation in BCNF?', ['When every determinant is a superkey', 'When it is in 1NF', 'When it has no NULLs', 'When it uses a surrogate key'], 0, 'BCNF requires the left side of every non-trivial dependency to be a superkey.'),
    ],
  };
  const BANK_TOPIC = new Map(Object.values(BANK).flat().map(q => [q.q, q.topic]));

  /* ═══════════════ Study guide banks (by document) ═══════════════ */
  const GUIDE = {
    'du-ml-w02': {
      summary: ['<p>Linear regression predicts a number as a weighted sum of the features, ŷ = w₀ + w₁x₁ + … + wₙxₙ, and learns the weights that minimize the mean squared error [1]. You can solve for them exactly with the normal equation, or step by step with gradient descent, which scales better to many features [2].</p>', '<p>Think of linear regression as fitting the best straight line (or plane) through the data: “best” means the smallest average squared distance between predictions and targets [1]. Gradient descent gets there by repeatedly nudging the weights downhill; the normal equation jumps straight to the answer but gets slow with many features [2].</p>'],
      simple: '<p>Linear regression draws the line that fits the data best — the one with the smallest squared errors [1]. The computer finds it either in one go or by taking many small steps downhill [2].</p>',
      cites: [C('du-ml-w02', 6, 'The model predicts ŷ = wᵀx and is trained by minimizing the mean squared error between predictions and targets.'), C('du-ml-w02', 27, 'Inverting XᵀX costs roughly O(n³) in the number of features; for large n prefer gradient descent.')],
      terms: [['Learning rate α', 'the size of each gradient descent step; too large diverges, too small is slow', C('du-ml-w02', 18, 'If α is too large gradient descent can overshoot and diverge; if it is too small, convergence is slow.')], ['Feature scaling', 'putting features on similar ranges so gradient descent converges faster', C('du-ml-w02', 21, 'When features have very different ranges the loss contours are elongated and gradient descent zig-zags; scaling features fixes this.')], ['Normal equation', 'w = (XᵀX)⁻¹Xᵀy, the exact solution in one step', C('du-ml-w02', 25, 'The normal equation w = (XᵀX)⁻¹Xᵀy gives the exact minimizer of the squared error.')], ['Stochastic gradient descent', 'updates from one example or a mini-batch at a time; noisy but fast', C('du-ml-w02', 30, 'Stochastic gradient descent estimates the gradient from a single example or a mini-batch, trading noise for speed.')]],
      example: { html: '<p>Predict a flat’s price (billion VND) from its area (m²). Start with w₀ = 0, w₁ = 0 and α = 0.01. For one flat of 50 m² costing 2.0, the prediction is 0 and the error is −2.0, so w₁ ← 0 − 0.01 · (−2.0 · 50) = 1.0. After this one step the model predicts 50 · 1.0 = 50 — wildly too high, because the area is on a much larger scale than the price. Scale the area first and the steps become sensible [1].</p>', cite: C('du-ml-w02', 21, 'When features have very different ranges the loss contours are elongated and gradient descent zig-zags; scaling features fixes this.') },
      check: ['Why does unscaled data slow gradient descent down?', 'When would you choose gradient descent over the normal equation?', 'What does the loss curve look like when α is too large?'],
    },
    'du-ml-w03': {
      summary: ['<p>Logistic regression is a classifier: it passes the linear score wᵀx through the sigmoid to get the probability of the positive class [1]. It is trained with cross-entropy, which stays convex, and its decision boundary is linear in the features [2].</p>', '<p>Instead of predicting a number, logistic regression predicts how likely an example is to be positive, using the sigmoid to squash scores into (0, 1) [1]. Training minimizes cross-entropy, which punishes confident mistakes and has a single minimum [2].</p>'],
      simple: '<p>Logistic regression answers yes/no questions with a probability between 0 and 1 [1]. It learns by punishing confident wrong answers the most [2].</p>',
      cites: [C('du-ml-w03', 5, 'The sigmoid σ(z) = 1/(1+e⁻ᶻ) maps any real number to a value between 0 and 1, read as the probability of class 1.'), C('du-ml-w03', 11, 'Logistic regression is trained by minimizing the cross-entropy loss, which is convex in the weights.')],
      terms: [['Sigmoid', 'σ(z) = 1/(1+e⁻ᶻ), maps any score to a probability', C('du-ml-w03', 5, 'The sigmoid σ(z) = 1/(1+e⁻ᶻ) maps any real number to a value between 0 and 1, read as the probability of class 1.')], ['Decision boundary', 'where σ(wᵀx) = 0.5, i.e. wᵀx = 0 — a straight line or plane', C('du-ml-w03', 8, 'Predicting class 1 when σ(wᵀx) ≥ 0.5 is the same as wᵀx ≥ 0, so the decision boundary is linear in x.')], ['Precision', 'TP / (TP + FP): how many predicted positives are real', C('du-ml-w03', 27, 'Precision is TP / (TP + FP): of everything predicted positive, how much really is positive.')], ['One-vs-rest', 'one binary classifier per class; the most confident wins', C('du-ml-w03', 20, 'One-vs-rest trains one binary classifier per class and predicts the class whose classifier gives the highest probability.')]],
      example: { html: '<p>A filter flags 90 of 100 spam emails and 30 normal ones. Precision = 90 / (90 + 30) = 75%; recall = 90 / 100 = 90%. Raising the threshold would flag fewer emails: precision goes up, recall goes down [1].</p>', cite: C('du-ml-w03', 29, 'A higher threshold predicts positive less often: precision tends to rise while recall falls.') },
      check: ['Why is the decision boundary of logistic regression linear?', 'Why not train logistic regression with squared error?', 'What happens to recall when you raise the threshold?'],
    },
    'du-ml-w04': {
      summary: ['<p>A model that is too flexible fits noise and generalizes poorly (high variance); one that is too simple misses the pattern (high bias) [1]. Regularization adds a penalty on the weights — λ‖w‖² for L2, λ‖w‖₁ for L1 — and λ, chosen on validation data, sets the trade-off between the two [2].</p>', '<p>Every model balances bias and variance: compare training and validation error to tell which one is hurting you [1]. Regularization shrinks the weights to control variance; tune its strength λ with cross-validation, never on the test set [2].</p>'],
      simple: '<p>If your model does great on training data but badly on new data, it is overfitting [1]. Regularization keeps the weights small so the model stays simpler; you pick how strong it is using a validation set [2].</p>',
      cites: [C('du-ml-w04', 15, 'High variance: training error is low but validation error is much higher. High bias: both errors are high.'), C('du-ml-w04', 21, 'Select λ with k-fold cross-validation; never tune hyper-parameters on the test set.')],
      terms: [['High variance', 'low training error, much higher validation error — overfitting', C('du-ml-w04', 15, 'High variance: training error is low but validation error is much higher. High bias: both errors are high.')], ['L2 regularization', 'adds λ‖w‖²; shrinks all weights but rarely to exactly zero', C('du-ml-w04', 7, 'L2 regularization adds λ‖w‖² to the loss, shrinking all weights toward zero without making them exactly zero.')], ['L1 regularization', 'adds λ‖w‖₁; sets some weights to exactly zero (feature selection)', C('du-ml-w04', 11, 'L1 regularization (lasso) can set weights exactly to zero, which performs feature selection.')], ['λ (lambda)', 'regularization strength; higher means less variance and more bias', C('du-ml-w04', 18, 'Increasing λ reduces variance but can increase bias; choose λ on a validation set.')]],
      example: { html: '<p>Training error 2%, validation error 19%: the gap says high variance. Try λ = 0.01, 0.1, 1 and 10 with 5-fold cross-validation and keep the λ with the lowest average validation error — say 0.1. Only then report the test error, once [1].</p>', cite: C('du-ml-w04', 21, 'Select λ with k-fold cross-validation; never tune hyper-parameters on the test set.') },
      check: ['How do you tell high bias from high variance using two numbers?', 'Why is the bias term w₀ usually not regularized?', 'Why must λ never be tuned on the test set?'],
    },
    'du-ml-w05': {
      summary: ['<p>A decision tree splits the data on the feature that makes the children purest — by Gini impurity in CART or by information gain [1]. Single trees overfit easily, so ensembles combine many: random forests average decorrelated trees, boosting adds trees that fix earlier mistakes [2].</p>', '<p>Trees ask a sequence of yes/no questions about the features, choosing each question to separate the classes as cleanly as possible [1]. Because one deep tree memorizes the data, practice uses ensembles — bagging and random forests to cut variance, boosting to cut bias [2].</p>'],
      simple: '<p>A decision tree is a flowchart of yes/no questions that sorts examples into groups [1]. Many trees voting together (a forest) work better than one [2].</p>',
      cites: [C('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.'), C('du-ml-w05', 33, 'Boosting builds models sequentially: each new tree concentrates on the examples the current ensemble gets wrong.')],
      terms: [['Gini impurity', 'how mixed the classes in a node are; CART’s default split criterion', C('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.')], ['Information gain', 'the drop in entropy from parent to children', C('du-ml-w05', 10, 'Information gain is the drop in entropy from the parent node to the weighted average of its children.')], ['Bagging', 'many models on bootstrap samples, averaged', C('du-ml-w05', 22, 'Bagging trains each model on a bootstrap sample of the training set and averages their predictions.')], ['Out-of-bag error', 'validation estimate from the samples each tree did not see', C('du-ml-w05', 29, 'Each tree leaves out about a third of the samples; predicting them gives the out-of-bag error, a free validation estimate.')]],
      example: { html: '<p>A node holds 6 “pass” and 4 “fail” students: Gini = 1 − (0.6² + 0.4²) = 0.48. Splitting on “attended ≥ 80%” gives children (5 pass, 0 fail) and (1 pass, 4 fail) with Gini 0 and 0.32 — a weighted 0.16, a clear improvement [1].</p>', cite: C('du-ml-w05', 8, 'CART uses Gini impurity to choose splits for classification trees.') },
      check: ['Why does a random forest sample features at each split?', 'What is the difference between bagging and boosting?', 'How would you stop a single tree from overfitting?'],
    },
    'du-ml-w06': {
      summary: ['<p>A neural network stacks layers of weighted sums followed by non-linear activations; without the non-linearity, the layers collapse into one linear model [1]. It learns with backpropagation — the chain rule applied layer by layer — and gradient descent [2].</p>', '<p>Each layer transforms its input with weights and an activation such as ReLU, so deep networks can fit very curved boundaries [1]. Backpropagation computes every weight’s gradient in one backward pass, and gradient descent uses them to update the network [2].</p>'],
      simple: '<p>A neural network is many simple units in layers; the bends between layers let it learn complicated patterns [1]. It improves by working out, for every weight, which way reduces the error [2].</p>',
      cites: [C('du-ml-w06', 6, 'Without a non-linear activation, any number of layers is equivalent to a single linear transformation.'), C('du-ml-w06', 14, 'Backpropagation applies the chain rule layer by layer to compute the gradient of the loss with respect to every weight.')],
      terms: [['ReLU', 'max(0, z); keeps gradients alive in deep networks', C('du-ml-w06', 19, 'Sigmoid saturates and its gradient vanishes for large inputs; ReLU keeps a gradient of 1 for positive inputs.')], ['Softmax', 'turns K scores into probabilities that sum to 1', C('du-ml-w06', 24, 'For K classes use K output units with softmax, which turns scores into probabilities that sum to 1.')], ['Dropout', 'randomly turns units off during training to regularize', C('du-ml-w06', 31, 'Dropout randomly sets a fraction of units to zero at each training step, which acts as regularization.')], ['Early stopping', 'keep the weights from the epoch with the best validation loss', C('du-ml-w06', 35, 'Early stopping keeps the weights from the epoch with the lowest validation loss.')]],
      example: { html: '<p>A 784–128–10 network for handwritten digits: 784 pixels in, 128 ReLU units, 10 softmax outputs. It has 784·128 + 128 + 128·10 + 10 = 101,770 weights. If validation loss bottoms out at epoch 12 and rises after, keep the epoch-12 weights [1].</p>', cite: C('du-ml-w06', 35, 'Early stopping keeps the weights from the epoch with the lowest validation loss.') },
      check: ['What would a network with only linear activations be able to learn?', 'Why can the sigmoid cause vanishing gradients?', 'Why must weights be initialized randomly?'],
    },
    'du-db-w05': {
      summary: ['<p>Joins combine rows from two tables on a condition: INNER JOIN keeps only matches, LEFT JOIN keeps every row of the left table and fills the gaps with NULL [1]. Subqueries nest one query inside another; a correlated subquery refers to the outer row and runs once per row [2].</p>', '<p>Choose the join by what you must not lose: INNER JOIN drops rows without a match, LEFT JOIN keeps them with NULLs [1]. Use a subquery when a condition depends on another query’s result — correlated when it depends on the current row [2].</p>'],
      simple: '<p>A join glues two tables together where their keys match; a LEFT JOIN also keeps rows that have no partner [1]. A subquery is a query inside another query [2].</p>',
      cites: [C('du-db-w05', 9, 'LEFT JOIN keeps every row of the left table; columns of the right table are NULL when there is no match.'), C('du-db-w05', 22, 'A correlated subquery refers to columns of the outer query, so it is evaluated once for each outer row.')],
      terms: [['INNER JOIN', 'only rows that match in both tables', C('du-db-w05', 6, 'INNER JOIN returns only the rows where the join condition matches in both tables.')], ['LEFT JOIN', 'every left row; right columns NULL when unmatched', C('du-db-w05', 9, 'LEFT JOIN keeps every row of the left table; columns of the right table are NULL when there is no match.')], ['IS NULL', 'the only correct test for a missing value', C('du-db-w05', 14, 'Comparisons with NULL are never true; use IS NULL to find rows that had no match.')], ['NOT EXISTS', 'safe anti-join even when the subquery returns NULLs', C('du-db-w05', 27, 'If the subquery returns a NULL, NOT IN yields no rows; NOT EXISTS is not affected by NULLs.')]],
      example: { html: '<p>Students with no enrollment: <code>SELECT s.name FROM Student s LEFT JOIN Enrollment e ON e.student_id = s.id WHERE e.student_id IS NULL;</code> Writing <code>= NULL</code> instead would return nothing [1].</p>', cite: C('du-db-w05', 14, 'Comparisons with NULL are never true; use IS NULL to find rows that had no match.') },
      check: ['When does INNER JOIN silently drop rows you needed?', 'Why can NOT IN return no rows at all?', 'What makes a subquery correlated?'],
    },
    'du-db-w07': {
      summary: ['<p>Normalization removes redundancy so each fact is stored once, preventing update, insertion and deletion anomalies [1]. Each normal form removes one kind of bad dependency: 2NF partial dependencies on part of a key, 3NF transitive dependencies, and BCNF any dependency whose left side is not a superkey [2].</p>', '<p>A badly designed table repeats the same fact in many rows, so updates go wrong [1]. Working up from 1NF to BCNF, you split tables until every attribute depends on the key, the whole key and nothing but the key [2].</p>'],
      simple: '<p>Normalization means storing each fact in one place only, so changing it can’t leave copies out of date [1]. You split big tables into smaller ones step by step [2].</p>',
      cites: [C('du-db-w07', 3, 'Redundancy causes update, insertion and deletion anomalies; normalization stores each fact once.'), C('du-db-w07', 17, '3NF removes transitive dependencies: non-key attributes must depend on the key, the whole key and nothing but the key.')],
      terms: [['1NF', 'every attribute holds one atomic value', C('du-db-w07', 5, 'First normal form requires every attribute to hold a single, atomic value: no lists or repeating groups.')], ['Partial dependency', 'a non-key attribute depending on part of a composite key (breaks 2NF)', C('du-db-w07', 11, '2NF forbids partial dependencies: a non-key attribute depending on only part of a composite key.')], ['Transitive dependency', 'key → A → B; removed by 3NF', C('du-db-w07', 17, '3NF removes transitive dependencies: non-key attributes must depend on the key, the whole key and nothing but the key.')], ['BCNF', 'every determinant is a superkey', C('du-db-w07', 23, 'A relation is in BCNF when, for every non-trivial functional dependency X → Y, X is a superkey.')]],
      example: { html: '<p>Enrollment(student_id, course_id, course_name, grade) with key (student_id, course_id): course_name depends on course_id alone. Split it into Enrollment(student_id, course_id, grade) and Course(course_id, course_name) — now renaming a course changes one row [1].</p>', cite: C('du-db-w07', 12, 'In Enrollment(student_id, course_id, course_name), course_name depends on course_id alone — a partial dependency.') },
      check: ['Give an example of an update anomaly.', 'What is the difference between 3NF and BCNF?', 'Which dependency does 2NF remove?'],
    },
  };

  /* ═══════════════ Document helpers ═══════════════ */
  const stripExt = n => String(n || '').replace(/\.[a-z0-9]+$/i, '');
  function docTopic(d) {
    const base = stripExt(d?.name);
    const m = base.match(/^(.{1,16}?)\s+—\s+(.+)$/);
    return m ? m[2] : base;
  }
  const shortTopic = d => docTopic(d).split(' & ')[0].replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const weekOf = d => +(String(d?.name || '').match(/^W0?(\d+)\b/)?.[1] || 0);
  function topicsLine(docs) {
    if (docs.length === 1) return docTopic(docs[0]);
    return docs.slice(0, 2).map(shortTopic).join(' & ') + (docs.length > 2 ? ` +${docs.length - 2}` : '');
  }
  function weeksLabel(docs) {
    const w = docs.map(weekOf);
    if (!w.length || w.some(x => !x)) return '';
    const s = [...new Set(w)].sort((a, b) => a - b);
    if (s.length === 1) return `Week ${s[0]}`;
    return s[s.length - 1] - s[0] === s.length - 1 ? `Weeks ${s[0]}–${s[s.length - 1]}` : `Weeks ${s.join(', ')}`;
  }
  const ctxDocs = ctx => (ctx.sources || []).map(docById).filter(Boolean);
  const isPractice = w => w.workflow === 'practice-quiz';
  const audit = (a, t) => X.work.audit(a, t);

  /** Questions for a document without a bank, built from its name and its neighbours. */
  function fallbackQuestions(d) {
    const topic = docTopic(d), pos = hashOf(d.id) % 4;
    const siblings = docsIn(d.kb).filter(x => x.id !== d.id);
    const other = [...siblings.map(docTopic), 'Course logistics and grading', 'Exam regulations', 'Academic integrity'].filter((t, i, a) => t !== topic && a.indexOf(t) === i).slice(0, 3);
    const place = (right, wrong) => { const o = [...wrong]; o.splice(pos, 0, right); return o.slice(0, 4); };
    const names = [...siblings.map(x => stripExt(x.name)), 'Syllabus', 'Academic calendar', 'Lab handbook'].filter((n, i, a) => a.indexOf(n) === i && n !== stripExt(d.name)).slice(0, 3);
    return [
      { q: `Which topic does “${stripExt(d.name)}” cover?`, options: place(topic, other), answer: pos, difficulty: 'easy', topic: topic.toLowerCase(), explain: `This document is the material on ${topic.toLowerCase()}.`, cite: C(d.id, 1, `${stripExt(d.name)} — an introduction to ${topic.toLowerCase()} and its key terms.`) },
      { q: `You need to revise ${topic.toLowerCase()}. Which document should you start with?`, options: place(stripExt(d.name), names), answer: pos, difficulty: 'medium', topic: `where ${topic.toLowerCase()} is covered`, explain: `“${stripExt(d.name)}” is where ${topic.toLowerCase()} is introduced.`, cite: C(d.id, 2, `This document introduces ${topic.toLowerCase()} and the terms used in the rest of the course.`) },
    ];
  }
  /** Interleave per-document banks so a quiz covers every chosen document. */
  function pool(sources) {
    const banks = sources.map(docById).filter(Boolean).map(d => BANK[d.id] || fallbackQuestions(d));
    const out = [];
    for (let i = 0; banks.some(b => i < b.length); i++) banks.forEach(b => b[i] && out.push(b[i]));
    return out;
  }

  /* ═══════════════ Quiz kind ═══════════════ */
  const qb = w => ui('quiz:' + w.id, {});
  const take = w => ui(`quizTake:${w.id}:${me().id}`, { mode: null, i: 0, answers: [] });
  const curWork = () => X.work.byId(S.cur?.params?.id);
  const scrollTop = () => $('#work-scroll')?.scrollTo({ top: 0 });
  const topicOf = q => q.topic || BANK_TOPIC.get(q.q) || '';
  const citeRef = q => q.cite?.doc ? `<span class="quiz-src">${X.work.cite(q.cite, 1)}<span class="truncate">${esc(stripExt(docById(q.cite.doc)?.name || ''))} · p. ${q.cite.page}</span></span>` : '';
  const classSize = (sp, s) => Math.max(s.attempts || 0, (sp?.memberCount || 0) - (sp?.members || []).filter(m => spaceType(sp.type).staff.includes(m.role)).length);
  /** The caller's answer to question q in an attempt (attempts remember question ids, so edits don't shift answers). */
  const answerOf = (a, q, i) => (a.qids ? (a.qids.indexOf(q.id) >= 0 ? a.answers[a.qids.indexOf(q.id)] : undefined) : a.answers[i]);

  function quizOptions(f, ctx) {
    const staff = WORKFLOWS[ctx.workflow]?.audience === 'staff';
    f.opts.count ??= staff ? 8 : 5; f.opts.mix ??= 'balanced';
    return `<div class="field"><span class="label" id="qo-count">Number of questions</span>${seg({ value: f.opts.count, options: [[5, '5'], [8, '8'], [10, '10']], act: 'quiz-opt', data: { k: 'count' }, label: 'Number of questions' })}</div>
      <div class="field"><span class="label">Difficulty</span>${seg({ value: f.opts.mix, options: [['easy', 'Mostly easy'], ['balanced', 'Balanced'], ['hard', 'Challenging']], act: 'quiz-opt', data: { k: 'mix' }, label: 'Difficulty' })}</div>
      <div class="field"><span class="label">Question type</span><div class="t-sm">Multiple choice · 4 answers · one correct</div></div>
      <div class="field">${staff ? alertBox('accent', 'For students — publish when ready', 'You review and edit every question first. Students see nothing until you publish.') : alertBox('default', 'Private practice', 'Only you see it. Each answer is checked right away, with its source.')}</div>`;
  }
  A['quiz-opt'] = el => { const f = ui('workNew'); f.opts[el.dataset.k] = el.dataset.k === 'count' ? +el.dataset.value : el.dataset.value; refresh(); };
  function quizTitle(ctx) {
    const docs = ctxDocs(ctx); if (!docs.length) return 'Quiz';
    if (ctx.workflow === 'practice-quiz') return `Practice — ${topicsLine(docs)}`;
    const wk = weeksLabel(docs);
    return `${wk ? wk + ' quiz' : 'Quiz'} — ${topicsLine(docs)}`;
  }
  function generateQuiz(ctx) {
    const n = ctx.options?.count || 8, mix = ctx.options?.mix || 'balanced';
    let p = pool(ctx.sources || []);
    if (mix !== 'balanced') { const order = mix === 'easy' ? ['easy', 'medium', 'hard'] : ['hard', 'medium', 'easy']; p = p.map((q, i) => [q, i]).sort((a, b) => order.indexOf(a[0].difficulty) - order.indexOf(b[0].difficulty) || a[1] - b[1]).map(x => x[0]); }
    const picks = p.slice(0, n);
    const practice = ctx.workflow === 'practice-quiz';
    return {
      timeLimit: practice ? null : picks.length <= 5 ? 10 : picks.length <= 8 ? 15 : 20, attemptsAllowed: practice ? 0 : 1,
      questions: picks.map((q, i) => ({ id: 'q' + (i + 1), ...clone(q) })),
      stats: { attempts: 0, avg: 0, byQuestion: [] }, attempts: [],
    };
  }
  function quizSummary(w) {
    const n = w.data?.questions?.length || 0, base = plural(n, 'question');
    if (isPractice(w)) { const best = Math.max(-1, ...(w.data?.attempts || []).map(a => a.score)); return best >= 0 ? `${base} · best ${best}/${n}` : `${base} · practice`; }
    if (w.status === 'published' && w.due) return `${base} · ${w.due < Date.now() ? 'closed' : 'due'} ${fmtDate(w.due)}`;
    return base;
  }

  function renderQuiz(w, ctx) {
    if (isPractice(w) && ctx.isOwner) return takeFlow(w, ctx, true);
    if (ctx.canEdit) return staffView(w, ctx);
    return takeFlow(w, ctx, false);
  }

  /* ── Staff: questions + results ── */
  function staffView(w, ctx) {
    const d = w.data || {}, qs = d.questions || [], s = d.stats || {}, published = w.status === 'published';
    const hasResults = published || (s.attempts || 0) > 0;
    const u = qb(w);
    const tab = hasResults ? (u.tab || ctx.query?.tab || (published && s.attempts ? 'results' : 'questions')) : 'questions';
    const sp = ctx.sp;
    const line = published
      ? `<div class="quiz-status">${ic('calendar', 'i-sm')}<span>${w.due ? `${w.due < Date.now() ? 'Closed' : 'Due'} ${esc(fmtDateTime(w.due))}` : 'Published'}</span><span aria-hidden="true">·</span><span>${d.attemptsAllowed === 1 ? 'One attempt' : 'Unlimited attempts'}</span><span aria-hidden="true">·</span><span>${fmtNum(s.attempts || 0)} of ${fmtNum(classSize(sp, s))} submitted</span></div>`
      : `<div class="quiz-status">${ic('eye-off', 'i-sm')}<span>Draft — only the teaching team can see it. Check the questions, then publish.</span></div>`;
    const tabsHtml = hasResults ? `<div class="quiz-tabs">${tabs([{ id: 'questions', label: 'Questions', count: qs.length }, { id: 'results', label: 'Results' }], tab, '', { variant: 'primary', act: 'quiz-tab' })}</div>` : '';
    return `${line}${tabsHtml}${tab === 'results' ? resultsView(w, ctx) : questionsView(w, ctx)}`;
  }
  A['quiz-tab'] = el => { const w = curWork(); if (!w) return; qb(w).tab = el.dataset.value; refresh(); };
  function questionsView(w, ctx) {
    const qs = w.data?.questions || [], u = qb(w), s = w.data?.stats || {};
    const cards = qs.map((q, i) => (u.edit === q.id ? editCard(w, q, i) : u.busy === q.id ? `<div class="card quiz-q" aria-busy="true"><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:45%"></span><span class="skeleton skeleton--line" style="width:55%"></span></div>` : qCard(w, q, i, ctx, s.byQuestion?.[i])));
    if (!qs.length) return emptyState({ icon: 'list', title: 'No questions yet', desc: 'Add one by hand.', actions: ctx.canEdit ? btn('Add question', { v: 'primary', icon: 'plus', act: 'quiz-add', data: { id: w.id } }) : '', boxed: true });
    return `<div class="quiz-list">${cards.join('')}</div>${ctx.canEdit && !u.edit ? `<div class="quiz-add">${btn('Add question', { icon: 'plus', act: 'quiz-add', data: { id: w.id } })}</div>` : ''}`;
  }
  function qCard(w, q, i, ctx, rate) {
    const [dl, dt] = DIFF[q.difficulty] || DIFF.medium;
    const acts = ctx.canEdit ? `<div class="quiz-q__acts">${iconBtn('pencil', 'Edit', { size: 'sm', act: 'quiz-edit', data: { id: w.id, q: q.id } })}${iconBtn('refresh', 'Regenerate', { size: 'sm', act: 'quiz-regen', data: { id: w.id, q: q.id } })}${iconBtn('trash', 'Remove', { size: 'sm', act: 'quiz-remove', data: { id: w.id, q: q.id } })}</div>` : '';
    return `<div class="card quiz-q" id="quiz-q-${q.id}">
      <div class="quiz-q__head"><span class="quiz-q__n">${i + 1}</span><div class="quiz-q__text">${esc(q.q)}</div>${acts}</div>
      <ol class="quiz-key">${q.options.map((o, j) => `<li class="quiz-key__opt ${j === q.answer ? 'is-correct' : ''}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="grow">${esc(o)}</span>${j === q.answer ? `<span class="quiz-key__tag">${ic('check', 'i-sm')}Correct</span>` : ''}</li>`).join('')}</ol>
      <div class="quiz-q__explain">${esc(q.explain || '')}</div>
      <div class="quiz-q__foot">${chip(dl, { tone: dt, size: 'sm' })}${rate != null && w.status === 'published' ? chip(`${Math.round(rate * 100)}% correct`, { size: 'sm', variant: 'outline' }) : ''}<span class="grow"></span>${citeRef(q)}</div>
    </div>`;
  }
  function editCard(w, q, i) {
    const e = S.ui.quizEdit || {};
    const missing = e.err ? e.options.map(o => !o.trim()) : [];
    return `<div class="card quiz-q quiz-q--edit" id="quiz-q-${q.id}">
      <div class="t-subheading">${e.isNew ? 'New question' : `Edit question ${i + 1}`}</div>
      ${field({ id: 'qe-q', label: 'Question', required: true, control: textarea({ id: 'qe-q', bind: 'quizEdit.q', value: e.q, rows: 2, invalid: e.err && !e.q.trim() }) })}
      <div class="field"><span class="label">Answers<span class="label__req" aria-hidden="true">*</span></span><div class="quiz-edit__opts">${e.options.map((o, j) => `<div class="quiz-edit__opt"><button type="button" class="quiz-edit__key ${e.answer === j ? 'is-on' : ''}" data-act="quiz-edit-answer" data-value="${j}" aria-pressed="${e.answer === j}" aria-label="Mark answer ${KEYS[j]} as correct" data-tip="Mark as correct">${e.answer === j ? ic('check', 'i-sm') : KEYS[j]}</button>${input({ id: 'qe-o' + j, bind: 'quizEdit.options.' + j, value: o, placeholder: `Answer ${KEYS[j]}`, attrs: `aria-label="Answer ${KEYS[j]}"`, invalid: missing[j] })}</div>`).join('')}</div><div class="description">Select a letter to mark the correct answer.</div></div>
      <div class="field"><span class="label">Difficulty</span>${seg({ value: e.difficulty, options: [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], act: 'quiz-edit-diff', label: 'Difficulty' })}</div>
      ${field({ id: 'qe-x', label: 'Explanation', optional: true, desc: 'Students see it after they answer.', control: textarea({ id: 'qe-x', bind: 'quizEdit.explain', value: e.explain, rows: 2 }) })}
      ${e.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(e.err)}</span></div>` : ''}
      <div class="quiz-edit__foot">${q.cite?.doc ? citeRef(q) : ''}<span class="grow"></span>${btn('Cancel', { v: 'ghost', act: 'quiz-edit-cancel' })}${btn('Save', { v: 'primary', act: 'quiz-edit-save' })}</div>
    </div>`;
  }
  function openEdit(w, q, isNew) {
    S.ui.quizEdit = { wid: w.id, qid: q.id, q: q.q, options: [...q.options], answer: q.answer, difficulty: q.difficulty || 'medium', explain: q.explain || '', isNew, err: '' };
    qb(w).edit = q.id; refresh();
    requestAnimationFrame(() => { $('#quiz-q-' + q.id)?.scrollIntoView({ block: 'nearest' }); $('#qe-q')?.focus(); });
  }
  A['quiz-edit'] = el => { const w = X.work.byId(el.dataset.id), q = w?.data.questions.find(x => x.id === el.dataset.q); if (q && X.work.canEdit(w)) openEdit(w, q, false); };
  A['quiz-edit-answer'] = el => { S.ui.quizEdit.answer = +el.dataset.value; refresh(); };
  A['quiz-edit-diff'] = el => { S.ui.quizEdit.difficulty = el.dataset.value; refresh(); };
  A['quiz-edit-cancel'] = () => {
    const e = S.ui.quizEdit, w = X.work.byId(e?.wid); if (!w) return;
    if (e.isNew) { const i = w.data.questions.findIndex(q => q.id === e.qid); if (i >= 0) w.data.questions.splice(i, 1); }
    qb(w).edit = null; S.ui.quizEdit = null; refresh();
  };
  A['quiz-edit-save'] = () => {
    const e = S.ui.quizEdit, w = X.work.byId(e?.wid); if (!w) return;
    if (!e.q.trim() || e.options.some(o => !o.trim())) { e.err = 'Write the question and all four answers.'; refresh(); return; }
    const q = w.data.questions.find(x => x.id === e.qid); if (!q) return;
    Object.assign(q, { q: e.q.trim(), options: e.options.map(o => o.trim()), answer: e.answer, difficulty: e.difficulty, explain: e.explain.trim() });
    delete q.topic;
    qb(w).edit = null; S.ui.quizEdit = null; X.work.save(w); refresh();
    toast(e.isNew ? 'Question added' : 'Question saved');
  };
  A['quiz-add'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w || !X.work.canEdit(w)) return;
    const q = { id: uid('q'), q: '', options: ['', '', '', ''], answer: 0, difficulty: 'medium', explain: '', cite: null };
    w.data.questions ??= []; w.data.questions.push(q); openEdit(w, q, true);
  };
  A['quiz-regen'] = async el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const qs = w.data.questions, i = qs.findIndex(x => x.id === el.dataset.q); if (i < 0) return;
    const used = new Set(qs.map(q => q.q));
    const next = pool(w.sources).find(q => !used.has(q.q));
    if (!next) { toast('No other questions in these materials. Edit this one instead.', { tone: 'accent' }); return; }
    qb(w).busy = qs[i].id; refresh();
    await sleep(700);
    const prev = qs[i], s = w.data.stats || {}, prevRate = s.byQuestion?.[i];
    qs[i] = { id: prev.id, ...clone(next) };
    if (s.byQuestion && i < s.byQuestion.length) s.byQuestion[i] = null;
    qb(w).busy = null; X.work.save(w); refresh();
    toast('Question replaced', { action: { label: 'Undo', run: () => { const j = qs.findIndex(x => x.id === prev.id); if (j >= 0) { qs[j] = prev; if (s.byQuestion && j < s.byQuestion.length) s.byQuestion[j] = prevRate; } X.work.save(w); refresh(); } } });
  };
  A['quiz-remove'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const qs = w.data.questions, i = qs.findIndex(x => x.id === el.dataset.q); if (i < 0) return;
    if (qs.length === 1) { toast('A quiz needs at least one question.', { tone: 'danger' }); return; }
    const [q] = qs.splice(i, 1), s = w.data.stats || {}, rate = s.byQuestion?.splice(i, 1);
    X.work.save(w); refresh();
    toast(`Removed question ${i + 1}`, { action: { label: 'Undo', run: () => { qs.splice(i, 0, q); if (rate?.length) s.byQuestion.splice(i, 0, rate[0]); X.work.save(w); refresh(); } } });
  };

  function resultsView(w, ctx) {
    const d = w.data, qs = d.questions || [], s = d.stats || { attempts: 0 };
    if (!s.attempts) return emptyState({ icon: 'chart', title: 'No answers yet', desc: w.due ? `Results show up here as students submit. The quiz closes ${esc(fmtDateTime(w.due))}.` : 'Results show up here as students submit.', boxed: true });
    const size = classSize(ctx.sp, s);
    const stats = `<div class="grid cols-2 quiz-stats">${statCard({ icon: 'users', label: 'Submitted', value: `${fmtNum(s.attempts)}<span class="quiz-stat__of"> of ${fmtNum(size)}</span>`, meta: `${pct(s.attempts, size)}% of the class` })}${statCard({ icon: 'target', label: 'Average score', value: `${(s.avg || 0).toFixed(1)}<span class="quiz-stat__of"> / ${qs.length}</span>`, meta: `${pct(s.avg || 0, qs.length)}%` })}</div>`;
    const rated = qs.map((q, i) => ({ q, i, r: s.byQuestion?.[i] })).filter(x => x.r != null).sort((a, b) => a.r - b.r);
    const hard = rated[0];
    const insight = hard && hard.r < 0.6 ? `<div class="mt-16">${alertBox('warning', `Q${hard.i + 1} — ${topicOf(hard.q) || `“${hard.q.q}”`} — only ${Math.round(hard.r * 100)}% correct`, `Correct answer: ${esc(hard.q.options[hard.q.answer])}. ${esc(hard.q.explain || '')}`, btn('Explain in class', { size: 'sm', v: 'secondary', icon: 'sparkles', act: 'quiz-explain', data: { id: w.id, q: hard.q.id } }), { icon: 'lightbulb' })}</div>` : '';
    const tone = r => (r < 0.5 ? 'danger' : r < 0.7 ? 'warning' : 'success');
    const barsHtml = rated.length ? `<div class="card quiz-bars">${rated.map(x => `<div class="quiz-bar"><span class="quiz-bar__n num">Q${x.i + 1}</span><span class="quiz-bar__q truncate" title="${esc(x.q.q)}">${esc(x.q.q)}</span><span class="quiz-bar__track">${progress(x.r * 100, tone(x.r), `Q${x.i + 1} correct rate`)}</span><span class="quiz-bar__pct num">${Math.round(x.r * 100)}%</span></div>`).join('')}</div>` : emptyState({ icon: 'chart', title: 'No answers for these questions yet', compact: true, boxed: true });
    return `${stats}${insight}${section('By question', barsHtml, { desc: 'Share of students who answered correctly, hardest first.' })}`;
  }
  A['quiz-explain'] = el => {
    const w = X.work.byId(el.dataset.id), q = w?.data.questions.find(x => x.id === el.dataset.q); if (!q) return;
    const i = w.data.questions.indexOf(q), r = w.data.stats?.byQuestion?.[i];
    const prompt = `Help me explain this in class: “${q.q}” Only ${Math.round((r || 0) * 100)}% of students answered correctly (the answer is “${q.options[q.answer]}”). Give a short explanation, a worked example and the most likely misconception, from the course materials.`;
    if (A['chat-ask']) A['chat-ask']({ dataset: { q: prompt, space: w.space, doc: q.cite?.doc } });
    else toast('The assistant isn’t available right now.', { tone: 'danger' });
  };

  /* ── Publish ── */
  const dueAt = days => { const d = new Date(Date.now() + days * DAY); d.setHours(23, 59, 0, 0); return d.getTime(); };
  A['quiz-publish'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    S.ui.quizPub = { days: '5', attempts: '1', notify: true, limit: String(w.data.timeLimit || 15) };
    openModal('quiz-publish', { id: w.id });
  };
  M['quiz-publish'] = p => {
    const w = X.work.byId(p.id), sp = spaceById(w?.space), f = S.ui.quizPub || {};
    if (!w || !sp) return { title: 'Publish quiz', body: '' };
    const n = w.data.questions.length;
    return {
      title: `Publish to ${sp.code || sp.name}`, desc: `${plural(n, 'question')} · students in ${esc(sp.name)} see it on Home and in the course.`,
      body: `<div class="quiz-pub">${field({ id: 'qp-due', label: 'Due', control: select({ id: 'qp-due', bind: 'quizPub.days', value: f.days, options: [3, 5, 7].map(dd => [String(dd), `In ${dd} days — ${new Date(dueAt(dd)).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`]) }) })}
        ${field({ id: 'qp-limit', label: 'Time limit', control: select({ id: 'qp-limit', bind: 'quizPub.limit', value: f.limit, options: [['10', '10 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['30', '30 minutes']] }) })}
        <div class="field"><span class="label">Attempts</span>${seg({ value: f.attempts, options: [['1', 'One attempt'], ['0', 'Unlimited']], act: 'quiz-pub-attempts', label: 'Attempts' })}</div>
        <div class="mt-8">${switchRow({ title: 'Notify students', desc: 'Posts an announcement in the course.', on: f.notify, act: 'quiz-pub-notify' })}</div></div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Publish', { v: 'primary', icon: 'send', act: 'quiz-pub-ok', data: { id: w.id } }),
    };
  };
  A['quiz-pub-attempts'] = el => { S.ui.quizPub.attempts = el.dataset.value; refreshLayer(); };
  A['quiz-pub-notify'] = () => { S.ui.quizPub.notify = !S.ui.quizPub.notify; refreshLayer(); };
  A['quiz-pub-ok'] = el => {
    const w = X.work.byId(el.dataset.id), sp = spaceById(w?.space), f = S.ui.quizPub; if (!w || !sp) return;
    const prev = { status: w.status, visibility: w.visibility, published: w.published, due: w.due, attemptsAllowed: w.data.attemptsAllowed, timeLimit: w.data.timeLimit };
    const due = dueAt(+f.days);
    Object.assign(w, { status: 'published', visibility: 'space', published: Date.now(), due });
    w.data.attemptsAllowed = +f.attempts; w.data.timeLimit = +f.limit;
    const evt = { id: uid('evt'), space: sp.id, kind: 'quiz', title: `${w.title.split(' — ')[0]} closes`, at: due, audience: 'members', work: w.id };
    (D.events ??= []).push(evt);
    let ann = null;
    if (f.notify) { ann = { id: uid('an'), by: me().id, at: Date.now(), title: `${w.title.split(' — ')[0]} is open`, text: `${plural(w.data.questions.length, 'question')}, ${f.limit} minutes. It closes ${new Date(due).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${+f.attempts === 1 ? '; you can take it once' : ''}.` }; (sp.announcements ??= []).unshift(ann); }
    audit('Published quiz', `${w.title} → ${sp.name}`);
    X.work.save(w); closeModal(); qb(w).tab = null; refresh();
    toast(`Published to ${sp.code || sp.name}${f.notify ? ' · students notified' : ''}`, { action: { label: 'Undo', run: () => {
      Object.assign(w, { status: prev.status, visibility: prev.visibility, published: prev.published, due: prev.due }); w.data.attemptsAllowed = prev.attemptsAllowed; w.data.timeLimit = prev.timeLimit;
      D.events = (D.events || []).filter(e => e !== evt); if (ann) sp.announcements = sp.announcements.filter(a => a !== ann);
      X.work.save(w); refresh(); toast('Back to draft');
    } } });
  };

  /* ── Students & practice: take the quiz ── */
  function takeFlow(w, ctx, practice) {
    const t = take(w), a = X.work.myAttempt(w), qs = w.data?.questions || [];
    if (!qs.length) return emptyState({ icon: 'list', title: 'This quiz has no questions', boxed: true });
    if (t.mode === 'taking') return takeView(w, t, practice);
    if (a && t.mode !== 'start') return resultView(w, a, ctx, practice);
    if (!practice && w.due && w.due < Date.now() && !a) return emptyState({ icon: 'clock', title: 'This quiz is closed', desc: `It closed ${esc(fmtDateTime(w.due))}. Ask the teaching team if you missed it for a good reason.`, actions: A['rq-ask-staff'] ? btn('Ask the teaching team', { act: 'quiz-ask', data: { id: w.id } }) : '', boxed: true });
    return startCard(w, a, practice);
  }
  function startCard(w, a, practice) {
    const d = w.data, n = d.questions.length;
    const facts = [plural(n, 'question'), d.timeLimit ? `${d.timeLimit} min` : 'No time limit', practice ? 'Instant feedback' : d.attemptsAllowed === 1 ? 'One attempt' : 'Unlimited attempts', !practice && w.due ? `Due ${fmtDateTime(w.due)}` : ''].filter(Boolean);
    const tries = (d.attempts || []).filter(x => x.user === me().id);
    const best = tries.length ? Math.max(...tries.map(x => x.score)) : null;
    return `<div class="card card--lg quiz-start">
      ${itemIcon(practice ? 'target' : 'check-circle', 'accent')}
      <div><h2 class="t-heading">${practice ? 'Practice quiz' : 'Ready when you are'}</h2><p class="t-sm muted mt-4">${practice ? 'Each answer is checked right away and explained with its source.' : 'Answer every question, then submit. You’ll see your score and why each answer is right.'}</p></div>
      <div class="quiz-facts">${facts.map(f => `<span class="quiz-fact">${esc(f)}</span>`).join('')}</div>
      ${best != null ? `<div class="t-sm muted">Best so far ${best}/${n} · ${plural(tries.length, 'try', 'tries')}</div>` : ''}
      <div class="row gap-8 wrap">${btn(a ? 'Try again' : 'Start quiz', { v: 'primary', icon: 'play', act: 'quiz-start', data: { id: w.id } })}${a ? btn('See last result', { act: 'quiz-last', data: { id: w.id } }) : ''}</div>
    </div>`;
  }
  function takeView(w, t, practice) {
    const qs = w.data.questions, n = qs.length, i = Math.min(t.i, n - 1), q = qs[i], ans = t.answers[i];
    const locked = practice && ans != null;
    const answered = qs.filter((_, j) => t.answers[j] != null).length;
    const left = !practice && w.data.timeLimit ? Math.max(0, Math.ceil((t.started + w.data.timeLimit * MIN - Date.now()) / MIN)) : null;
    const opts = q.options.map((o, j) => {
      const st = locked ? (j === q.answer ? 'is-correct' : j === ans ? 'is-wrong' : '') : '';
      return `<label class="quiz-opt ${ans === j ? 'is-picked' : ''} ${st}"><input type="radio" id="qt-${q.id}-${j}" name="qt-${q.id}" value="${j}" ${ans === j ? 'checked' : ''} ${locked ? 'disabled' : ''} data-change="quiz-pick" data-id="${w.id}" data-i="${i}" data-value="${j}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="quiz-opt__text">${esc(o)}</span>${locked && j === q.answer ? ic('check-circle', 'quiz-opt__icon') : locked && j === ans ? ic('x-circle', 'quiz-opt__icon') : ''}</label>`;
    }).join('');
    const right = ans === q.answer;
    const feedback = locked ? `<div class="quiz-feedback ${right ? 'is-right' : 'is-wrong'}" role="status"><div class="quiz-feedback__title">${ic(right ? 'check-circle' : 'x-circle', 'i-sm')}${right ? 'Correct' : `Not quite — the answer is ${KEYS[q.answer]}`}</div><p>${esc(q.explain || '')}</p>${citeRef(q)}</div>` : '';
    const last = i === n - 1;
    return `<div class="card card--lg quiz-take">
      <div class="quiz-take__top"><span class="t-sm medium">Question ${i + 1} of ${n}</span><span class="t-sm muted num">${left != null ? `${left} min left` : `${answered} answered`}</span></div>
      ${progress(((i + 1) / n) * 100, '', `Question ${i + 1} of ${n}`)}
      <h2 class="quiz-take__q" id="qt-label">${esc(q.q)}</h2>
      <div class="quiz-opts" role="radiogroup" aria-labelledby="qt-label">${opts}</div>
      ${feedback}
      <div class="quiz-take__nav">${btn('Back', { icon: 'arrow-left', act: 'quiz-nav', data: { id: w.id, d: -1 }, disabled: i === 0 })}${btn('Exit', { v: 'ghost', act: 'quiz-exit', data: { id: w.id } })}<span class="grow"></span>${last ? btn(practice ? 'See results' : 'Submit', { v: 'primary', icon: 'check', act: 'quiz-submit', data: { id: w.id } }) : btn('Next', { v: ans != null ? 'primary' : 'tertiary', iconRight: 'arrow-right', act: 'quiz-nav', data: { id: w.id, d: 1 } })}</div>
    </div>`;
  }
  A['quiz-start'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    if (!isPractice(w) && w.data.attemptsAllowed === 1 && X.work.myAttempt(w)) return;
    Object.assign(take(w), { mode: 'taking', i: 0, answers: [], started: Date.now() }); refresh(); scrollTop();
  };
  A['quiz-last'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).mode = 'result'; refresh(); scrollTop(); };
  A['quiz-exit'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).mode = X.work.myAttempt(w) ? 'result' : 'start'; refresh(); scrollTop(); };
  A['quiz-pick'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; take(w).answers[+el.dataset.i] = +el.dataset.value; refresh(); };
  A['quiz-nav'] = el => { const w = X.work.byId(el.dataset.id); if (!w) return; const t = take(w); t.i = Math.max(0, Math.min(w.data.questions.length - 1, t.i + +el.dataset.d)); refresh(); scrollTop(); };
  A['quiz-submit'] = el => {
    const w = X.work.byId(el.dataset.id); if (!w) return;
    const t = take(w), qs = w.data.questions, open = qs.filter((_, i) => t.answers[i] == null).length;
    const practice = isPractice(w);
    if (practice && !open) return submit(w);
    confirmAction({
      title: open ? `Submit with ${plural(open, 'unanswered question')}?` : 'Submit your answers?',
      body: open ? 'Unanswered questions count as wrong.' : w.data.attemptsAllowed === 1 ? 'You can take this quiz once, so you can’t change answers after this.' : 'You can try again afterwards.',
      confirm: 'Submit', delay: 300, onConfirm: () => submit(w),
    });
  };
  function submit(w) {
    const t = take(w), qs = w.data.questions, d = w.data;
    const answers = qs.map((_, i) => t.answers[i] ?? null);
    const score = qs.filter((q, i) => answers[i] === q.answer).length;
    const att = { id: uid('at'), user: me().id, at: Date.now(), answers, qids: qs.map(q => q.id), score, total: qs.length };
    (d.attempts ??= []).push(att);
    if (!isPractice(w)) {
      const s = d.stats ??= { attempts: 0, avg: 0, byQuestion: [] }, n = s.attempts || 0;
      s.byQuestion = qs.map((q, i) => (((s.byQuestion?.[i] ?? 0) * n) + (answers[i] === q.answer ? 1 : 0)) / (n + 1));
      s.avg = ((s.avg || 0) * n + score) / (n + 1); s.attempts = n + 1;
      audit('Submitted quiz', w.title);
    }
    Object.assign(t, { mode: 'result', i: 0, answers: [] });
    persist(); refresh(); scrollTop();
    toast(`Submitted · ${score} of ${qs.length} correct`);
  }
  const missedOf = (w, a) => (w.data.questions || []).filter((q, i) => answerOf(a, q, i) !== q.answer);
  function resultView(w, a, ctx, practice) {
    const qs = w.data.questions, p = pct(a.score, a.total), missed = missedOf(w, a), sp = ctx.sp;
    const msg = p >= 80 ? 'Strong result.' : p >= 50 ? 'A good base — a few things to review.' : 'Worth another look at the materials.';
    const canGuide = workflowsFor(sp).some(f => f.id === 'study-guide');
    const canAsk = !!A['rq-ask-staff'] && !!sp && !isSpaceStaff(sp);
    const retake = practice || w.data.attemptsAllowed !== 1;
    const next = [
      canGuide && btn(missed.length ? 'Make a study guide on what I missed' : 'Make a study guide', { v: 'primary', icon: 'book', act: 'quiz-guide', data: { id: w.id } }),
      canAsk && btn('Ask the teaching team', { icon: 'message', act: 'quiz-ask', data: { id: w.id } }),
      retake && btn('Try again', { icon: 'retry', act: 'quiz-start', data: { id: w.id } }),
    ].filter(Boolean).join('');
    const review = qs.map((q, i) => {
      const ans = answerOf(a, q, i), ok = ans === q.answer;
      return `<div class="card quiz-q quiz-q--review">
        <div class="quiz-q__head"><span class="quiz-q__n ${ok ? 'is-right' : 'is-wrong'}" aria-label="${ok ? 'Correct' : 'Incorrect'}">${ic(ok ? 'check' : 'x', 'i-sm')}</span><div class="quiz-q__text">${i + 1}. ${esc(q.q)}</div></div>
        <ol class="quiz-key">${q.options.map((o, j) => `<li class="quiz-key__opt ${j === q.answer ? 'is-correct' : j === ans ? 'is-wrong' : ''}"><span class="quiz-opt__key">${KEYS[j]}</span><span class="grow">${esc(o)}</span>${j === q.answer ? `<span class="quiz-key__tag">${ic('check', 'i-sm')}${j === ans ? 'Your answer' : 'Correct answer'}</span>` : j === ans ? `<span class="quiz-key__tag">${ic('x', 'i-sm')}Your answer</span>` : ''}</li>`).join('')}</ol>
        ${ans == null ? '<div class="t-xs muted">Not answered</div>' : ''}
        <div class="quiz-q__explain">${esc(q.explain || '')}</div>
        <div class="quiz-q__foot"><span class="grow"></span>${citeRef(q)}</div>
      </div>`;
    }).join('');
    return `<div class="card card--lg quiz-score">
        <div class="quiz-score__row"><div><div class="t-label">Your score</div><div class="quiz-score__num num">${a.score}<span>/${a.total}</span></div></div><div class="grow"><div class="t-subheading">${msg}</div><div class="t-sm muted">${p}% · submitted ${esc(rel(a.at))}${missed.length ? ` · ${plural(missed.length, 'question')} to review` : ''}</div></div></div>
        ${progress(p, p >= 80 ? 'success' : p >= 50 ? 'warning' : 'danger', 'Score')}
        ${next ? `<div class="quiz-next"><div class="t-label">Next step</div><div class="row gap-8 wrap">${next}</div></div>` : ''}
      </div>
      ${section('Your answers', `<div class="quiz-list">${review}</div>`)}`;
  }
  A['quiz-guide'] = el => {
    const w = X.work.byId(el.dataset.id), a = w && X.work.myAttempt(w); if (!w) return;
    const missed = a ? missedOf(w, a) : [];
    const docs = [...new Set(missed.map(q => q.cite?.doc).filter(Boolean))];
    const short = w.title.split(' — ')[0];
    A['work-start']({ dataset: { workflow: 'study-guide', space: w.space, docs: (docs.length ? docs : w.sources).join(','), title: missed.length ? `${short} — what I missed` : `${short} — study guide`, from: missed.length ? w.id : '' } });
  };
  A['quiz-ask'] = el => {
    const w = X.work.byId(el.dataset.id), a = w && X.work.myAttempt(w); if (!w) return;
    const m = a ? missedOf(w, a)[0] : null, i = m ? w.data.questions.indexOf(m) : -1;
    const mine = m ? m.options[answerOf(a, m, i)] : null;
    const q = m ? `About ${w.title}, question ${i + 1}: “${m.q}” ${mine ? `I chose “${mine}”` : 'I left it blank'}, but the answer is “${m.options[m.answer]}”. Could you explain why?` : `Question about ${w.title}: `;
    if (A['rq-ask-staff']) A['rq-ask-staff']({ dataset: { space: w.space, q } });
    else toast('Requests aren’t available right now.', { tone: 'danger' });
  };
  function quizActions(w, ctx) {
    if (isPractice(w) || !ctx.canEdit || w.status === 'published' || !ctx.sp) return '';
    return btn(`Publish to ${ctx.sp.code || ctx.sp.name}`, { v: 'primary', icon: 'send', act: 'quiz-publish', data: { id: w.id }, disabled: !w.data?.questions?.length || !!qb(w).edit });
  }
  const quizHtml = w => `<ol>${(w.data.questions || []).map(q => `<li><p>${esc(q.q)}</p><ol type="A">${q.options.map((o, j) => `<li>${esc(o)}${j === q.answer ? ' <b>(correct)</b>' : ''}</li>`).join('')}</ol>${q.explain ? `<p><i>${esc(q.explain)}</i></p>` : ''}${q.cite?.doc ? `<p><small>Source: ${esc(docById(q.cite.doc)?.name || '')}, page ${q.cite.page}</small></p>` : ''}</li>`).join('')}</ol>`;
  const quizLines = w => (w.data.questions || []).flatMap((q, i) => [`${i + 1}. ${q.q}`, ...q.options.map((o, j) => `   ${KEYS[j]}. ${o}${j === q.answer ? '  (correct)' : ''}`), q.explain ? `   ${q.explain}` : '', '']);

  WORK_KINDS.quiz = {
    label: 'Quiz', icon: 'check-circle', noun: 'questions',
    options: quizOptions, title: quizTitle, generate: generateQuiz, render: renderQuiz, actions: quizActions, summary: quizSummary,
    exportHtml: quizHtml, exportLines: quizLines,
    canDownload: (w, ctx) => ctx.canEdit || isPractice(w) || !!X.work.myAttempt(w),
  };

  /* ═══════════════ Study guide kind ═══════════════ */
  const gb = w => ui('guide:' + w.id, {});
  function fallbackGuide(d) {
    const topic = docTopic(d), t = topic.toLowerCase(), c = C(d.id, 1, `${stripExt(d.name)} — an introduction to ${t} and its key terms.`);
    return {
      summary: [`<p><i>${esc(stripExt(d.name))}</i> introduces ${esc(t)}: the main ideas, the terms used and how they connect to the rest of the course [1].</p>`, `<p>This part of the course is about ${esc(t)} — what it is, why it matters and the terms you need to follow later material [1].</p>`],
      simple: `<p>This document explains ${esc(t)} and the words you need to know [1].</p>`,
      cites: [c], terms: [[esc(topic), 'the main subject of this document; its definitions are on the first pages', C(d.id, 2, `This document introduces ${t} and defines its key terms.`)]],
      example: null, check: [`What are the two most important ideas in “${topic}”?`, `How does ${t} connect to earlier material?`],
    };
  }
  const banksFor = sources => sources.map(docById).filter(Boolean).map(d => [d, GUIDE[d.id] || fallbackGuide(d)]);
  const firstSentence = html => html.replace(/<p>(.*?)<\/p>/s, (m, t) => `<p>${(t.match(/^.*?[.!?](\s*\[\d+\])?(?=\s|$)/s) || [t])[0]}</p>`);
  const KEY_BY_TITLE = { 'In one paragraph': 'summary', 'Key terms': 'terms', 'Worked example': 'example', 'Check yourself': 'check', 'What you missed': 'missed' };
  const TITLE = { summary: 'In one paragraph', terms: 'Key terms', example: 'Worked example', check: 'Check yourself', missed: 'What you missed' };
  /** Build one section from the banks. o = { v (variant), mode: short|simple, depth, from (quiz id) }. */
  function buildSection(key, banks, o = {}) {
    const v = o.v || 0, short = o.mode === 'short', simple = o.mode === 'simple', quick = o.depth === 'quick';
    if (key === 'summary') {
      const parts = banks.slice(0, quick ? 2 : 3).map(([, g]) => ({ html: simple ? g.simple : g.summary[v % g.summary.length], cites: g.cites }));
      let off = 0; const cs = [];
      const text = parts.map(p => { const h = (short ? firstSentence(p.html) : p.html).replace(/\[(\d+)\]/g, (m, n) => `[${+n + off}]`); off += p.cites.length; cs.push(...p.cites); return h.replace(/<\/?p>/g, ''); }).join(' ');
      return { html: `<p>${text}</p>`, cites: cs };
    }
    if (key === 'terms') {
      let all = banks.flatMap(([, g]) => g.terms);
      if (!all.length) return null;
      const k = v % all.length; all = [...all.slice(k), ...all.slice(0, k)];
      const terms = all.slice(0, short ? 3 : quick ? 4 : 8);
      return { html: `<ul>${terms.map(([t, def], i) => `<li><b>${t}</b> — ${simple ? def.split(/[;(]/)[0].trim() : def} [${i + 1}]</li>`).join('')}</ul>`, cites: terms.map(t => t[2]) };
    }
    if (key === 'example') {
      const ex = banks.map(([, g]) => g.example).filter(Boolean);
      if (!ex.length) return null;
      const e = ex[v % ex.length];
      return { html: short || simple ? firstSentence(e.html) : e.html, cites: [e.cite] };
    }
    if (key === 'check') {
      let qs = banks.flatMap(([, g]) => g.check);
      if (!qs.length) return null;
      const k = v % qs.length; qs = [...qs.slice(k), ...qs.slice(0, k)];
      return { html: `<ol>${qs.slice(0, short ? 3 : 5).map(q => `<li>${esc(q)}</li>`).join('')}</ol>`, cites: [] };
    }
    if (key === 'missed') {
      const quiz = X.work.byId(o.from), a = quiz && X.work.myAttempt(quiz);
      const missed = a ? missedOf(quiz, a) : [];
      if (!missed.length) return null;
      const list = short ? missed.slice(0, 2) : missed;
      return { html: `<ul>${list.map((q, i) => `<li><b>${esc(q.q)}</b> The answer is “${esc(q.options[q.answer])}”.${simple ? '' : ` ${esc(q.explain || '')}`} [${i + 1}]</li>`).join('')}</ul>`, cites: list.map(q => q.cite).filter(Boolean) };
    }
    return null;
  }
  function generateGuide(ctx) {
    const banks = banksFor(ctx.sources || []), o = ctx.options || {};
    const depth = o.depth || 'full', check = o.check !== false;
    const keys = [o.from && 'missed', 'summary', 'terms', depth === 'full' && 'example', check && 'check'].filter(Boolean);
    const sections = keys.map(k => [k, buildSection(k, banks, { depth, from: o.from })]).filter(([, s]) => s).map(([k, s], i) => ({ id: 's' + (i + 1), key: k, title: TITLE[k], html: s.html, cites: s.cites, v: 0 }));
    return { depth, check, sections };
  }
  function guideOptions(f) {
    f.opts.depth ??= 'full'; f.opts.check ??= true;
    const from = f.opts.from && X.work.byId(f.opts.from);
    return `${from ? `<div class="field">${alertBox('accent', 'Focused on what you missed', `Starts with the questions you got wrong in ${esc(from.title)}.`)}</div>` : ''}
      <div class="field"><span class="label">Depth</span>${seg({ value: f.opts.depth, options: [['quick', 'Quick summary'], ['full', 'Full guide']], act: 'guide-opt', data: { k: 'depth' }, label: 'Depth' })}<div class="description">${f.opts.depth === 'quick' ? 'A paragraph and the key terms.' : 'Summary, key terms and a worked example.'}</div></div>
      <div class="field">${switchRow({ title: 'Include check-yourself questions', desc: 'A few open questions to test your understanding.', on: f.opts.check, act: 'guide-opt-check' })}</div>`;
  }
  A['guide-opt'] = el => { ui('workNew').opts[el.dataset.k] = el.dataset.value; refresh(); };
  A['guide-opt-check'] = () => { const f = ui('workNew'); f.opts.check = !f.opts.check; refresh(); };
  const guideTitle = ctx => { const docs = ctxDocs(ctx); return docs.length ? `${topicsLine(docs)} — study guide` : 'Study guide'; };
  function renderGuide(w, ctx) {
    const secs = w.data?.sections || [], u = gb(w);
    if (!secs.length) return emptyState({ icon: 'book', title: 'This guide is empty', boxed: true });
    return `<article class="guide">${secs.map(s => {
      const acts = ctx.canEdit ? `<div class="guide-sec__acts">${iconBtn('refresh', 'Regenerate', { size: 'sm', act: 'guide-rewrite', data: { id: w.id, s: s.id, mode: 'regen' }, disabled: !!u.busy })}${btn('Rewrite', { v: 'ghost', size: 'sm', iconRight: 'chevron-down', menu: 'guide-rw', data: { id: w.id + ':' + s.id }, disabled: !!u.busy })}</div>` : '';
      const body = u.busy === s.id ? `<div class="stack gap-8" aria-busy="true"><span class="skeleton skeleton--line" style="width:92%"></span><span class="skeleton skeleton--line" style="width:85%"></span><span class="skeleton skeleton--line" style="width:60%"></span></div>` : X.work.cites(s.html, s.cites);
      return `<section class="guide-sec" aria-labelledby="gs-${s.id}"><div class="guide-sec__head"><h2 class="guide-sec__title" id="gs-${s.id}">${esc(s.title)}</h2>${s.mode ? chip(s.mode === 'short' ? 'Shorter' : 'Simpler', { size: 'sm' }) : ''}<span class="grow"></span>${acts}</div><div class="guide-sec__body">${body}</div></section>`;
    }).join('')}</article>`;
  }
  MENUS['guide-rw'] = el => {
    const [id, s] = el.dataset.id.split(':');
    return [{ label: 'Shorter', icon: 'sliders', run: () => rewrite(id, s, 'short') }, { label: 'Simpler', icon: 'lightbulb', run: () => rewrite(id, s, 'simple') }];
  };
  A['guide-rewrite'] = el => rewrite(el.dataset.id, el.dataset.s, el.dataset.mode);
  async function rewrite(id, sid, mode) {
    const w = X.work.byId(id), sec = w?.data.sections.find(s => s.id === sid); if (!sec || !X.work.canEdit(w)) return;
    const key = sec.key || KEY_BY_TITLE[sec.title]; if (!key) return;
    const u = gb(w); u.busy = sec.id; refresh();
    await sleep(800);
    const opts = { v: mode === 'regen' ? (sec.v || 0) + 1 : sec.v || 0, mode: mode === 'regen' ? null : mode, depth: w.data.depth || 'full', from: w.options?.from };
    const nu = buildSection(key, banksFor(w.sources), opts);
    u.busy = null;
    if (!nu) { refresh(); toast('Couldn’t rewrite this section from these materials.', { tone: 'danger' }); return; }
    const prev = { html: sec.html, cites: sec.cites, v: sec.v, mode: sec.mode, key: sec.key };
    Object.assign(sec, { html: nu.html, cites: nu.cites, v: opts.v, mode: opts.mode, key });
    X.work.save(w); refresh();
    toast(mode === 'regen' ? 'Section regenerated' : mode === 'short' ? 'Made shorter' : 'Made simpler', { action: { label: 'Undo', run: () => { Object.assign(sec, prev); X.work.save(w); refresh(); } } });
  }
  function guideActions(w, ctx) {
    const flows = workflowsFor(ctx.sp).map(f => f.id);
    const wf = flows.includes('practice-quiz') ? ['practice-quiz', 'Practice quiz from this'] : flows.includes('quiz') && ctx.isStaff ? ['quiz', 'Make a quiz from this'] : null;
    return (wf ? btn(wf[1], { icon: 'target', act: 'work-start', data: { workflow: wf[0], space: w.space || '', docs: w.sources.join(',') } }) : '')
      + iconBtn('download', 'Download', { menu: 'work-dl', data: { id: w.id }, muted: false });
  }
  const sup = (html, cs) => String(html).replace(/\[(\d+)\]/g, (m, n) => (cs[n - 1] ? `<sup>[${n}]</sup>` : ''));
  const guideHtml = w => (w.data.sections || []).map(s => `<h2>${esc(s.title)}</h2>${sup(s.html, s.cites || [])}${s.cites?.length ? `<p><small>${s.cites.map((c, i) => `[${i + 1}] ${esc(docById(c.doc)?.name || '')}, page ${c.page} — “${esc(c.quote)}”`).join('<br>')}</small></p>` : ''}`).join('');
  const toText = html => String(html).replace(/<li>/g, '\n• ').replace(/<\/(p|h\d|ul|ol)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const guideLines = w => (w.data.sections || []).flatMap(s => [s.title.toUpperCase(), ...toText(s.html.replace(/\s*\[(\d+)\]/g, ' [$1]')).split('\n').map(l => l.trim()).filter(Boolean), '']);

  WORK_KINDS.guide = {
    label: 'Study guide', icon: 'book', noun: 'study guide',
    options: guideOptions, title: guideTitle, generate: generateGuide, render: renderGuide, actions: guideActions,
    summary: w => `${plural(w.data?.sections?.length || 0, 'section')}${w.data?.depth === 'quick' ? ' · quick summary' : ''}`,
    exportHtml: guideHtml, exportLines: guideLines, headerDownload: true,
  };
})();
