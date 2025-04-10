const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeTeamblind(config) {
  // 설정 기본값 설정
  const searchKeyword = config.keyword || '폰 대리점';
  const maxPosts = config.maxPosts || 100; // 기본값 100개
  const saveComments = config.saveComments !== false; // 기본적으로 댓글 수집

  // 출력 디렉토리 생성
  const outputDir = './teamblind_data';
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
  }

  // 날짜를 포함한 파일명 생성
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputBaseName = `teamblind_${searchKeyword}_${dateStr}`;
  const outputPath = path.join(outputDir, `${outputBaseName}.json`);
  const tempOutputPath = path.join(outputDir, `${outputBaseName}_temp.json`);
  
  // 브라우저 실행
  const browser = await puppeteer.launch({ 
    headless: false, // 브라우저 화면 표시
    defaultViewport: null, // 뷰포트 자동 조정
    timeout: 60000 // 타임아웃 60초로 설정
  });
  
  const page = await browser.newPage();
  
  // 페이지 타임아웃 설정
  await page.setDefaultNavigationTimeout(60000);
  
  // 데이터를 저장할 배열
  let posts = [];
  
  // 이전 데이터가 있으면 불러오기
  if (fs.existsSync(tempOutputPath)) {
    try {
      console.log('기존 임시 데이터 파일을 불러옵니다.');
      const tempData = JSON.parse(fs.readFileSync(tempOutputPath, 'utf8'));
      posts = tempData.posts || [];
      console.log(`임시 파일에서 ${posts.length}개의 게시물을 불러왔습니다.`);
    } catch (e) {
      console.error('임시 파일 불러오기 실패:', e);
    }
  }
  
  try {
    // 검색 결과 페이지로 이동
    const encodedKeyword = encodeURIComponent(searchKeyword);
    await page.goto(`https://www.teamblind.com/kr/search/${encodedKeyword}`, {
      waitUntil: 'networkidle2'
    });
    
    console.log(`"${searchKeyword}" 키워드로 검색한, 팀블라인드 검색 결과 페이지를 스크랩합니다.`);
    
    let previousHeight = 0;
    let isEnd = false;
    let scrollCount = 0;
    
    // 중간 저장 함수
    const saveTemporaryData = () => {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        posts: posts
      }, null, 2));
      console.log(`임시 데이터가 ${tempOutputPath}에 저장되었습니다.`);
    };
    
    // 무한 스크롤 처리
    while (!isEnd && scrollCount < 20 && posts.length < maxPosts) { // 최대 20회 스크롤 또는 설정한 게시물 수에 도달할 때까지
      // 현재 스크랩된 게시물 개수 출력
      console.log(`현재 ${posts.length}개의 게시물이 스크랩되었습니다. (목표: ${maxPosts}개)`);
      
      // 게시물 목록 가져오기
      const newPosts = await page.evaluate(async (currentPosts, keyword) => {
        const postElements = Array.from(document.querySelectorAll('.article-list-pre:not(.article-list-ad):not(.coupang-ad)'));
        const results = [];
        
        for (const postEl of postElements) {
          try {
            // 이미 수집한 게시물인지 확인 (URL로 체크)
            const postUrl = postEl.querySelector('.tit a') ? postEl.querySelector('.tit a').href : null;
            if (!postUrl || currentPosts.some(p => p.url === postUrl)) continue;
            
            // 제목
            const title = postEl.querySelector('.tit h3') ? postEl.querySelector('.tit h3').textContent.trim() : '';
            
            // 내용 미리보기
            const previewText = postEl.querySelector('.pre-txt a') ? postEl.querySelector('.pre-txt a').textContent.trim() : '';
            
            // 작성자 정보
            const authorElement = postEl.querySelector('.sub .name a');
            const authorText = authorElement ? authorElement.textContent.trim() : '';
            // 회사와 사용자명 분리
            const authorParts = authorText.split('·');
            const company = authorParts[0]?.trim() || '';
            const author = authorParts[1]?.trim() || '';
            
            // 조회수
            const viewElement = postEl.querySelector('.pv');
            const views = viewElement ? 
              parseInt(viewElement.textContent.replace(/[^0-9]/g, '')) : 0;
            
            // 좋아요
            const likeElement = postEl.querySelector('.like');
            const likeText = likeElement ? likeElement.textContent.trim() : '좋아요';
            const likes = likeText !== '좋아요' ? parseInt(likeText.replace(/[^0-9]/g, '')) : 0;
            
            // 댓글 수
            const commentElement = postEl.querySelector('.cmt');
            const commentCount = commentElement ? 
              parseInt(commentElement.textContent.replace(/[^0-9]/g, '')) : 0;
            
            // 날짜
            const dateElement = postEl.querySelector('.past');
            const date = dateElement ? dateElement.textContent.replace(/[_작성시간_]/g, '').trim() : '';
            
            // 카테고리
            const categoryElement = postEl.querySelector('.category .topic-name');
            const category = categoryElement ? categoryElement.textContent.trim() : '';
            
            results.push({
              keyword,
              title,
              url: postUrl,
              preview: previewText,
              company,
              author,
              category,
              date,
              views,
              likes,
              commentCount,
              comments: [] // 댓글은 나중에 수집
            });
          } catch (e) {
            console.error('게시물 파싱 중 오류:', e);
          }
        }
        
        return results;
      }, posts, searchKeyword);
      
      // 새 게시물 추가
      posts.push(...newPosts);
      
      // 설정한 최대 게시물 수를 초과한 경우 잘라내기
      if (posts.length > maxPosts) {
        console.log(`설정한 최대 게시물 수(${maxPosts}개)를 초과했습니다. 초과분을 제거합니다.`);
        posts = posts.slice(0, maxPosts);
        isEnd = true; // 스크롤 중단
      }
      
      // 새 게시물이 추가되었으면 임시 파일에 저장
      if (newPosts.length > 0) {
        saveTemporaryData();
      }
      
      // 스크롤 내리기
      previousHeight = await page.evaluate('document.body.scrollHeight');
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      
      // 로딩 대기 (직접 타임아웃 처리)
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 스크롤이 더 이상 내려가지 않는지 확인
      const currentHeight = await page.evaluate('document.body.scrollHeight');
      if (currentHeight === previousHeight) {
        isEnd = true;
        console.log('더 이상 스크롤 할 수 없습니다. 스크래핑을 종료합니다.');
      }
      
      scrollCount++;
    }
    
    console.log(`총 ${posts.length}개의 게시물을 찾았습니다.`);
    
    // 댓글 수집이 활성화된 경우에만 수행
    if (saveComments) {
      console.log("이제 각 게시물의 댓글을 수집합니다.");
      
      // 각 게시물의 댓글 수집
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        console.log(`게시물 ${i+1}/${posts.length} 댓글 수집 중: ${post.title}`);
        
        // 이미 댓글이 수집된 게시물은 건너뛰기
        if (post.comments && post.comments.length > 0) {
          console.log(`게시물 ${i+1}/${posts.length}은 이미 댓글이 수집되었습니다. 건너뜁니다.`);
          continue;
        }
        
        try {
          // 게시물 페이지로 이동
          await page.goto(post.url, { waitUntil: 'networkidle2' });
          
          // 댓글 초기화
          posts[i].comments = [];
          
          // 첫 페이지 댓글 수집 함수
          const collectCommentsOnCurrentPage = async () => {
            const newComments = await page.evaluate(() => {
              // 실제 팀블라인드 댓글 구조에 맞게 셀렉터 수정
              const commentElements = Array.from(document.querySelectorAll('.wrap-comment.comment_area'));
              const results = [];
              
              for (const commentEl of commentElements) {
                try {
                  // 댓글 내용이 없는 요소 무시 (댓글 작성 폼 등)
                  if (!commentEl.textContent.trim()) continue;
                  
                  // 회사명
                  const companyEl = commentEl.querySelector('a.point');
                  const company = companyEl ? companyEl.textContent.trim() : '';
                  
                  // 닉네임 - 회사명 다음에 오는 텍스트
                  const nameEl = commentEl.querySelector('p.name');
                  let nickname = '';
                  if (nameEl) {
                    const nameText = nameEl.textContent.trim();
                    // 회사명 이후의 · 뒤에 오는 부분이 닉네임
                    const parts = nameText.split('·');
                    if (parts.length > 1) {
                      nickname = parts[1].trim();
                    }
                  }
                  
                  // 작성자 여부 확인
                  const isAuthor = !!commentEl.querySelector('em.op');
                  
                  // 내용
                  const contentEl = commentEl.querySelector('p.cmt-txt');
                  const content = contentEl ? contentEl.textContent.trim() : '';
                  
                  // 이미지 첨부 확인
                  const hasImage = !!commentEl.querySelector('p.attach-img');
                  
                  // 날짜
                  const dateEl = commentEl.querySelector('span.date');
                  let date = '';
                  if (dateEl) {
                    const dateText = dateEl.textContent.trim();
                    // '작성일2019.11.28.' 형식에서 날짜만 추출
                    const dateMatch = dateText.match(/\d{4}\.\d{1,2}\.\d{1,2}/);
                    date = dateMatch ? dateMatch[0] : dateText.replace(/작성일/i, '').trim();
                  }
                  
                  // 좋아요 수
                  const likeEl = commentEl.querySelector('span.like, a.like');
                  let likes = 0;
                  if (likeEl) {
                    const likeText = likeEl.textContent.trim();
                    if (likeText !== '좋아요' && likeText !== '좋아요수좋아요') {
                      const likeMatch = likeText.match(/\d+/);
                      if (likeMatch) {
                        likes = parseInt(likeMatch[0]);
                      }
                    }
                  }
                  
                  // 대댓글 여부 확인 - class="wrap-reply" 내부에 있으면 대댓글
                  const isReply = !!commentEl.closest('.wrap-reply');
                  
                  // 대댓글 수
                  const commentCountEl = commentEl.querySelector('span.cmt');
                  let commentCount = 0;
                  if (commentCountEl) {
                    const cmtText = commentCountEl.textContent.trim();
                    if (cmtText !== '대댓글') {
                      const cmtMatch = cmtText.match(/\d+/);
                      if (cmtMatch) {
                        commentCount = parseInt(cmtMatch[0]);
                      }
                    }
                  }
                  
                  // 댓글 ID (고유 ID 속성 가져오기)
                  const commentId = commentEl.id || '';
                  
                  results.push({
                    id: commentId,
                    nickname,
                    company,
                    content,
                    date,
                    likes,
                    hasImage,
                    commentCount,
                    isReply,
                    isAuthor
                  });
                } catch (e) {
                  console.error('댓글 파싱 중 오류:', e);
                }
              }
              
              return results;
            });
            
            return newComments;
          };
          
          // "더보기" 버튼 클릭 - 대댓글 펼치기
          const expandReplies = async () => {
            return await page.evaluate(() => {
              const moreBtns = Array.from(document.querySelectorAll('button.btn-reply'));
              let clicked = 0;
              
              for (const btn of moreBtns) {
                if (btn.textContent.includes('대댓글') || btn.textContent.includes('더보기')) {
                  btn.click();
                  clicked++;
                  // 버튼이 사라지거나 DOM에서 변경될 수 있으므로 바로 처리
                }
              }
              return clicked;
            });
          };
          
          // 대댓글 확장 버튼 클릭
          let expandedCount = await expandReplies();
          if (expandedCount > 0) {
            console.log(`${expandedCount}개의 대댓글 더보기 버튼을 클릭했습니다.`);
            // 대댓글 로딩 대기
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
          // 첫 페이지 댓글 수집
          const firstPageComments = await collectCommentsOnCurrentPage();
          posts[i].comments = firstPageComments;
          console.log(`게시물 "${post.title}"의 첫 페이지에서 ${firstPageComments.length}개의 댓글을 수집했습니다.`);
          
          // 개별 게시물 댓글 수집 후 중간 저장
          saveTemporaryData();
          
          // 댓글이 많을 경우 페이지 전환하여 추가 로드
          const hasMorePages = await page.evaluate(() => {
            // 페이지네이션 요소 확인
            return !!document.querySelector('.pagination, .page-list');
          });
          
          if (hasMorePages) {
            console.log(`게시물 "${post.title}"에 추가 댓글 페이지가 있습니다.`);
            
            // 댓글 페이지 수 확인
            const commentPageCount = await page.evaluate(() => {
              // 다양한 페이지네이션 구조 대응
              const pageElements = document.querySelectorAll('.pagination a:not(.prev):not(.next), .page-list a:not(.prev):not(.next), [class*="pagination"] a:not([class*="prev"]):not([class*="next"])');
              
              if (pageElements.length === 0) return 1;
              
              // 마지막 페이지 번호 구하기
              const pageNumbers = Array.from(pageElements)
                .map(el => {
                  const num = parseInt(el.textContent.trim());
                  return isNaN(num) ? 0 : num;
                })
                .filter(num => num > 0);
              
              return pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;
            });
            
            console.log(`총 ${commentPageCount}개의 댓글 페이지가 있습니다.`);
            
            // 첫 페이지 댓글들은 이미 수집했으므로 2페이지부터 시작
            for (let pageNum = 2; pageNum <= commentPageCount; pageNum++) {
              try {
                console.log(`댓글 페이지 ${pageNum}/${commentPageCount} 로드 중...`);
                
                // 페이지 번호 클릭하여 이동 (다양한 페이지네이션 구조 대응)
                const pageClicked = await page.evaluate((pageN) => {
                  // 다양한 페이지네이션 요소 시도
                  const selectors = [
                    `.pagination a:not(.prev):not(.next)`,
                    `.page-list a:not(.prev):not(.next)`,
                    `[class*="pagination"] a:not([class*="prev"]):not([class*="next"])`,
                    `nav > a:not([class*="prev"]):not([class*="next"])`
                  ];
                  
                  for (const selector of selectors) {
                    const pageLinks = document.querySelectorAll(selector);
                    if (pageLinks.length === 0) continue;
                    
                    const targetPage = Array.from(pageLinks).find(el => {
                      return el.textContent.trim() === String(pageN) || 
                             el.textContent.trim() === String(pageN);
                    });
                    
                    if (targetPage) {
                      targetPage.click();
                      return true;
                    }
                  }
                  
                  // 특정 페이지 요소가 없을 경우 다음 페이지 버튼 시도
                  const nextButtons = document.querySelectorAll('.next, [class*="next"], a[rel="next"]');
                  if (nextButtons.length > 0) {
                    nextButtons[0].click();
                    return true;
                  }
                  
                  return false;
                }, pageNum);
                
                if (!pageClicked) {
                  console.log(`페이지 ${pageNum}으로 이동할 수 없습니다. 페이지네이션 요소를 찾을 수 없습니다.`);
                  break;
                }
                
                // 페이지 로딩 대기
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // AJAX 로딩 대기
                try {
                  await page.waitForFunction(() => {
                    return !document.querySelector('.loading, .spinner, [class*="loading"]');
                  }, { timeout: 5000 });
                } catch (e) {
                  // 로딩 인디케이터 없을 경우 무시
                  console.log('로딩 인디케이터를 찾을 수 없습니다. 계속 진행합니다.');
                }
                
                // 현재 페이지 댓글 수집
                const pageComments = await collectCommentsOnCurrentPage();
                
                // 새 댓글 추가
                posts[i].comments.push(...pageComments);
                console.log(`페이지 ${pageNum}에서 ${pageComments.length}개의 댓글을 추가했습니다. 총 댓글 수: ${posts[i].comments.length}`);
                
                // 페이지별 댓글 수집 후에도 중간 저장
                saveTemporaryData();
                
                // 요청 간 지연
                await new Promise(resolve => setTimeout(resolve, 1500));
              } catch (e) {
                console.error(`댓글 페이지 ${pageNum} 로드 중 오류:`, e);
                // 오류가 발생해도 계속 진행하고 중간 저장
                saveTemporaryData();
              }
            }
          }
          
          // 필터링: 빈 댓글 제거
          posts[i].comments = posts[i].comments.filter(comment => 
            comment.content && comment.content.trim().length > 0
          );
          
          console.log(`게시물 "${post.title}"에서 총 ${posts[i].comments.length}개의 유효한 댓글을 수집했습니다.`);
          
          // 모든 댓글 수집 후 중간 저장
          saveTemporaryData();
          
          // 과도한 요청을 방지하기 위한 지연
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e) {
          console.error(`게시물 ${post.title} 댓글 수집 중 오류:`, e);
          // 오류가 발생해도 중간 저장
          saveTemporaryData();
        }
      }
    } else {
      console.log("댓글 수집이 비활성화되어 있어 댓글은 수집하지 않습니다.");
    }
    
    // 최종 결과 저장
    fs.writeFileSync(outputPath, JSON.stringify({
      keyword: searchKeyword,
      count: posts.length,
      lastUpdated: new Date().toISOString(),
      posts: posts
    }, null, 2));
    
    console.log(`스크래핑이 완료되었습니다. 결과는 ${outputPath} 파일에 저장되었습니다.`);
    
    // 임시 파일 삭제
    if (fs.existsSync(tempOutputPath)) {
      fs.unlinkSync(tempOutputPath);
      console.log(`임시 파일 ${tempOutputPath}이 삭제되었습니다.`);
    }
    
    // 브라우저 종료
    await browser.close();
    
    return posts;
  } catch (error) {
    console.error('스크래핑 중 오류가 발생했습니다:', error);
    
    // 오류가 발생해도 중간 결과 저장
    if (posts.length > 0) {
      fs.writeFileSync(tempOutputPath, JSON.stringify({
        keyword: searchKeyword,
        count: posts.length,
        lastUpdated: new Date().toISOString(),
        error: error.message,
        posts: posts
      }, null, 2));
      console.log(`오류가 발생했지만 중간 결과는 ${tempOutputPath}에 저장되었습니다.`);
    }
    
    await browser.close();
    throw error;
  }
}

// 실행 부분
const searchKeyword = '폰 대리점'; // 검색할 키워드 설정
const maxPostsToCollect = 200; // 최대 수집할 게시물 수 설정

// 설정 객체 생성
const crawlerConfig = {
  keyword: searchKeyword,
  maxPosts: maxPostsToCollect,
  saveComments: true // 댓글도 함께 수집할지 여부
};

scrapeTeamblind(crawlerConfig)
  .then(() => console.log('스크래핑 프로세스가 성공적으로 완료되었습니다.'))
  .catch(err => console.error('스크래핑 중 오류가 발생했습니다:', err));